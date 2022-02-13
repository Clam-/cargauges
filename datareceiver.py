from pymodules.TwFile import FILE # import this before all others to inject mimetype.
from time import time
from twisted.web import resource, server
from twisted.internet import reactor, endpoints, task
from pymodules.UDPData import UDPData
from pymodules.HTTPData import HTTPData
from pymodules.Bridge import Bridge

TICKLENGTH = 1.0 # seconds
BUFFER = 3000 # milliseconds
HDATA = HTTPData()

def runEveryTick():
    q = Bridge.queue
    # peek top item and compare to time to see if delay is up.
    #print(q.queue, Bridge.shorttime(), Bridge.shorttime()+BUFFER)
    if not q.empty() and (q.queue[0][0]+BUFFER < Bridge.shorttime()):
        HDATA.stats.update(q.get()[1]) # fetch the second item which is the data
    return
def tickFailed(failure):
    print(failure.getBriefTraceback())

root = resource.Resource()
root.putChild(b"static", FILE)
root.putChild(b"data", HDATA)
endpoint = endpoints.TCP4ServerEndpoint(reactor, 8069)
endpoint.listen(server.Site(root))
reactor.listenUDP(42069, UDPData(HDATA))
loop = task.LoopingCall(runEveryTick)
loopDeferred = loop.start(TICKLENGTH)
loopDeferred.addErrback(tickFailed)
reactor.run()
