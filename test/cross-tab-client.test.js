var TestPair = require('logux-core').TestPair
var TestTime = require('logux-core').TestTime
var delay = require('nanodelay')

var CrossTabClient = require('../cross-tab-client')

beforeEach(function () {
  global.WebSocket = function () { }
  global.WebSocket.prototype = {
    close: function () { }
  }
  Object.defineProperty(global, '_localStorage', {
    value: {
      storage: { },
      setItem: function (key, value) {
        this[key] = value
        this.storage[key] = value
      },
      getItem: function (key) {
        return this.storage[key]
      },
      removeItem: function (key) {
        delete this[key]
        delete this.storage[key]
      }
    }
  })
})

var client
var originWindow = global.window
var originNavigator = global.navigator
var originWebSocket = global.WebSocket
var originIndexedDB = global.indexedDB
afterEach(function () {
  if (client) {
    client.destroy()
    client = undefined
  }
  global.window = originWindow
  global.navigator = originNavigator
  global.WebSocket = originWebSocket
  global.indexedDB = originIndexedDB
})

function createClient (overrides) {
  if (!overrides) overrides = { }
  var opts = {
    subprotocol: '1.0.0',
    server: 'wss://localhost:1337',
    userId: false,
    time: new TestTime()
  }
  for (var i in overrides) {
    opts[i] = overrides[i]
  }
  var result = new CrossTabClient(opts)
  result.electionDelay = result.electionDelay / 20
  result.leaderTimeout = result.leaderTimeout / 20
  result.leaderPing = result.leaderPing / 20
  return result
}

function emitStorage (name, value) {
  var event = new Event('storage')
  event.key = name
  event.newValue = value
  window.dispatchEvent(event)
}

it('saves options', function () {
  client = new CrossTabClient({
    subprotocol: '1.0.0',
    server: 'wss://localhost:1337',
    userId: false
  })
  expect(client.options.subprotocol).toEqual('1.0.0')
})

it('supports nanoevents API', function () {
  client = createClient()

  var twice = []
  var unbind = client.on('add', function (action) {
    twice.push(action.type)
    if (action.type === 'B') unbind()
  })

  return client.log.add({ type: 'A' }).then(function () {
    return client.log.add({ type: 'B' })
  }).then(function () {
    return client.log.add({ type: 'C' })
  }).then(function () {
    expect(twice).toEqual(['A', 'B'])
  })
})

it('cleans everything', function () {
  client = createClient()

  client.node.destroy = jest.fn()
  localStorage.removeItem = jest.fn()

  return client.clean().then(function () {
    expect(client.node.destroy).toHaveBeenCalled()
    expect(localStorage.removeItem.mock.calls).toEqual([
      ['logux:false:add'], ['logux:false:clean'],
      ['logux:false:state'], ['logux:false:leader']
    ])
  })
})

it('does not use broken localStorage', function () {
  localStorage.setItem = function () {
    throw new Error('The quota has been exceeded')
  }
  client = new CrossTabClient({
    subprotocol: '1.0.0',
    server: 'wss://localhost:1337',
    userId: 10
  })
  return client.log.add({ type: 'A' }, { reasons: ['tab' + client.id] })
})

it('synchronizes actions between tabs', function () {
  localStorage.setItem = function (name, value) {
    emitStorage(name, value)
  }
  var client1 = new CrossTabClient({
    subprotocol: '1.0.0',
    server: 'wss://localhost:1337',
    userId: 10
  })
  var client2 = new CrossTabClient({
    subprotocol: '1.0.0',
    server: 'wss://localhost:1337',
    userId: 10
  })
  var client3 = new CrossTabClient({
    subprotocol: '1.0.0',
    server: 'wss://localhost:1337',
    prefix: 'other',
    userId: 10
  })
  var client4 = new CrossTabClient({
    subprotocol: '1.0.0',
    server: 'wss://localhost:1337',
    userId: 20
  })

  var events = []
  client1.on('add', function (action, meta) {
    events.push(['add', action, meta.reasons])
  })
  client1.on('clean', function (action, meta) {
    events.push(['clean', action, meta.reasons])
  })

  return client2.log.add({ type: 'A' }).then(function () {
    return client3.log.add({ type: 'B' })
  }).then(function () {
    return client2.log.add({ type: 'C' }, { tab: client1.id })
  }).then(function () {
    return client2.log.add({ type: 'D' }, { tab: client2.id })
  }).then(function () {
    return client4.log.add({ type: 'E' })
  }).then(function () {
    expect(events).toEqual([
      ['add', { type: 'A' }, []],
      ['clean', { type: 'A' }, []],
      ['add', { type: 'C' }, []],
      ['clean', { type: 'C' }, []]
    ])
  })
})

it('synchronizes actions from follower tabs', function () {
  var pair = new TestPair()
  client = createClient({ server: pair.left })
  client.start()
  return pair.wait('left').then(function () {
    pair.right.send(['connected', client.node.localProtocol, 'server', [0, 0]])
    return client.node.waitFor('synchronized')
  }).then(function () {
    return delay(1)
  }).then(function () {
    pair.clear()
    client.node.timeFix = 0
    var action = JSON.stringify({ type: 'A' })
    var meta = JSON.stringify({
      added: 1,
      time: 1,
      sync: true,
      id: '1 false:other 0'
    })
    emitStorage('logux:false:add', '["other",' + action + ',' + meta + ']')
    return delay(50)
  }).then(function () {
    expect(pair.leftSent).toEqual([
      ['sync', 1, { type: 'A' }, { id: [1, 'false:other', 0], time: 1 }]
    ])
  })
})

it('uses candidate role from beggining', function () {
  client = createClient()
  expect(client.role).toEqual('candidate')
})

it('becomes leader without localStorage', function () {
  Object.defineProperty(global, '_localStorage', { value: undefined })
  client = createClient()

  var roles = []
  client.on('role', function () {
    roles.push(client.role)
  })
  client.node.connection.connect = jest.fn()

  client.start()
  expect(roles).toEqual(['leader'])
  expect(client.node.connection.connect).toHaveBeenCalled()
})

it('becomes leader without window', function () {
  delete global.window
  delete global.navigator
  Object.defineProperty(global, '_localStorage', { value: undefined })

  client = createClient()
  client.start()

  expect(client.role).toEqual('leader')
  client.destroy()
})

it('becomes follower on recent leader ping', function () {
  localStorage.setItem('logux:false:leader', '["",' + Date.now() + ']')
  client = createClient()

  var roles = []
  client.on('role', function () {
    roles.push(client.role)
  })
  client.node.connection.connect = jest.fn()

  client.start()
  expect(roles).toEqual(['follower'])
  expect(client.node.connection.connect).not.toHaveBeenCalled()
  expect(client.watching).toBeDefined()
})

it('stops election on second candidate', function () {
  client = createClient()

  client.start()
  expect(client.role).toEqual('candidate')

  localStorage.setItem('logux:false:leader', '["",' + (Date.now() - 10) + ']')
  return delay(client.electionDelay + 10).then(function () {
    expect(client.role).toEqual('follower')
    expect(client.watching).toBeDefined()
  })
})

it('stops election in leader check', function () {
  client = createClient()

  client.start()
  expect(client.role).toEqual('candidate')

  localStorage.setItem('logux:false:leader', '["",' + Date.now() + ']')
  return delay(client.electionDelay + 10).then(function () {
    expect(client.role).toEqual('follower')
    expect(client.watching).toBeDefined()
  })
})

it('pings on leader role', function () {
  client = createClient()
  client.node.connection.disconnect = jest.fn()

  var last = Date.now() - client.leaderTimeout - 10
  localStorage.setItem('logux:false:leader', '["",' + last + ']')

  client.start()
  expect(client.role).toEqual('candidate')
  return delay(client.electionDelay + 10).then(function () {
    expect(client.role).toEqual('leader')
    expect(client.watching).toBeUndefined()
    return delay(client.leaderPing + 10)
  }).then(function () {
    var data = JSON.parse(localStorage.getItem('logux:false:leader'))
    expect(data[0]).toEqual(client.id)
    expect(Date.now() - data[1]).toBeLessThan(100)

    emitStorage('logux:false:leader', '["",' + Date.now() + ']')
    expect(client.role).toEqual('follower')
    expect(client.watching).toBeDefined()
  })
})

it('has random timeout', function () {
  var client1 = createClient()
  var client2 = createClient()
  expect(client1.roleTimeout).not.toEqual(client2.roleTimeout)
})

it('replaces dead leader', function () {
  client = createClient()
  client.roleTimeout = client.leaderTimeout / 2

  localStorage.setItem('logux:false:leader', '["",' + Date.now() + ']')
  client.start()

  return delay(client.roleTimeout).then(function () {
    expect(client.role).toEqual('follower')
    return delay(client.leaderTimeout + client.roleTimeout)
  }).then(function () {
    expect(client.role).not.toEqual('follower')
  })
})

it('disconnects on leader changes', function () {
  client = createClient()
  client.node.connection.disconnect = jest.fn()

  client.start()
  return delay(client.electionDelay + 10).then(function () {
    client.node.state = 'connected'

    var now = Date.now()
    localStorage.setItem('logux:false:leader', '["",' + now + ']')
    emitStorage('logux:false:leader', '["",' + now + ']')

    expect(client.node.connection.disconnect).toHaveBeenCalled()
  })
})

it('updates state if tab is a leader', function () {
  client = createClient()

  client.start()
  expect(client.state).toEqual('disconnected')

  return delay(client.electionDelay + 10).then(function () {
    client.node.state = 'synchronized'
    client.node.emitter.emit('state')
    expect(client.state).toEqual('synchronized')
    expect(localStorage.getItem('logux:false:state')).toEqual('"synchronized"')
  })
})

it('listens for leader state', function () {
  localStorage.setItem('logux:false:leader', '["",' + Date.now() + ']')
  localStorage.setItem('logux:false:state', '"connecting"')

  client = createClient()
  var states = []
  client.on('state', function () {
    states.push(client.state)
  })
  client.start()
  expect(states).toEqual(['connecting'])

  localStorage.removeItem('logux:false:state')
  emitStorage('logux:false:state', null)
  expect(states).toEqual(['connecting'])

  localStorage.setItem('logux:false:state', '"synchronized"')
  emitStorage('logux:false:state', null)
  emitStorage('logux:false:state', '"sending"')
  emitStorage('logux:false:state', '"synchronized"')
  expect(states).toEqual(['connecting', 'synchronized'])
})

it('has connected shortcut', function () {
  client = createClient()
  expect(client.connected).toBeFalsy()
  client.state = 'connecting'
  expect(client.connected).toBeFalsy()
  client.state = 'sending'
  expect(client.connected).toBeTruthy()
})

it('works on IE storage event', function () {
  client = createClient()

  var events = 0
  client.on('add', function () {
    events += 1
  })
  client.on('clean', function () {
    events += 1
  })

  client.start()
  emitStorage('logux:false:leader', localStorage.getItem('logux:false:leader'))

  return delay(client.electionDelay + 10).then(function () {
    expect(client.role).toEqual('leader')

    emitStorage('logux:false:add', '["' + client.id + '",{},{"id":"0 A 0"}]')
    emitStorage('logux:false:clean', '["' + client.id + '",{},{"id":"0 A 0"}]')
    expect(events).toEqual(0)
  })
})

it('sends unleader event on tab closing', function () {
  client = createClient()
  client.start()
  return delay(client.electionDelay + 10).then(function () {
    window.dispatchEvent(new Event('unload'))
    expect(localStorage.getItem('logux:false:leader')).toEqual('[]')
  })
})

it('sends unleader event on destroy', function () {
  client = createClient()
  client.start()
  return delay(client.electionDelay + 10).then(function () {
    client.destroy()
    expect(localStorage.getItem('logux:false:leader')).toEqual('[]')
  })
})

it('does not sends event on tab closing in following mode', function () {
  client = createClient()

  var prevLeader = '["",' + Date.now() + ']'
  localStorage.setItem('logux:false:leader', prevLeader)
  client.start()

  return delay(client.electionDelay + 10).then(function () {
    expect(localStorage.getItem('logux:false:leader')).toEqual(prevLeader)
  })
})

it('starts election on leader unload', function () {
  client = createClient()

  localStorage.setItem('logux:false:leader', '["",' + Date.now() + ']')
  localStorage.setItem('logux:false:state', '"synchronized"')

  client.start()
  return delay(client.electionDelay + 10).then(function () {
    emitStorage('logux:false:leader', '[]')
    expect(client.role).toEqual('candidate')
    expect(client.state).toEqual('disconnected')
    expect(localStorage.getItem('logux:false:state')).toEqual('"disconnected"')
    expect(localStorage.getItem('logux:false:leader')).toContain(client.id)
  })
})

it('changes state on dead leader', function () {
  client = createClient()

  var last = Date.now() - client.leaderTimeout - 1
  localStorage.setItem('logux:false:leader', '["",' + last + ']')
  localStorage.setItem('logux:false:state', '"connecting"')

  client.start()
  expect(client.state).toEqual('disconnected')
})

it('changes state on leader death', function () {
  client = createClient()
  client.roleTimeout = 20

  var last = Date.now() - client.leaderTimeout + 10
  localStorage.setItem('logux:false:leader', '["",' + last + ']')
  localStorage.setItem('logux:false:state', '"sending"')

  client.start()
  return delay(client.roleTimeout + 20).then(function () {
    expect(client.state).toEqual('disconnected')
    expect(localStorage.getItem('logux:false:state')).toEqual('"disconnected"')
  })
})

it('cleans tab-specific action after timeout', function () {
  client = createClient()

  localStorage.setItem('logux:tab:1', Date.now() - client.tabTimeout - 1)
  return client.log.add({ type: 'A' }, { reasons: ['tab1'] }).then(function () {
    client.start()
    return Promise.resolve()
  }).then(function () {
    expect(client.log.actions()).toHaveLength(0)
  })
})

it('detects subscriptions from different tabs', function () {
  client = createClient()
  emitStorage('logux:false:add', '["other",' +
    '{"type":"logux/subscribe","name":"a"},{"sync":true,"id":"0 A 0"}' +
  ']')
  expect(client.subscriptions).toEqual([
    { type: 'logux/subscribe', name: 'a' }
  ])
})

it('copies actions on memory store', function () {
  client = createClient()

  emitStorage('logux:false:add', '["other",{"type":"A"},{"id":"1 A 0"}]')
  expect(client.log.actions()).toEqual([{ type: 'A' }])

  emitStorage('logux:false:clean', '["other",{"type":"A"},{"id":"1 A 0"}]')
  expect(client.log.actions()).toHaveLength(0)
})
