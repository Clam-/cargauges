from pymodules.TwFile import FILE # import this before all others to inject mimetype.
from time import time
from twisted.web import resource, server
from twisted.internet import reactor, endpoints, task
from pymodules.UDPData import UDPData
from pymodules.HTTPData import HTTPData
from pymodules.Bridge import Bridge


Bridge.PACKET_SPAM = True
Bridge.origtime = time()
TICKLENGTH = 5.0 # seconds
HDATA = HTTPData()

def runEveryTick():
    #send orig time every tick.
    Bridge.udpsend({"OT": Bridge.origtime})
    return

root = resource.Resource()
root.putChild(b"static", FILE)
root.putChild(b"data", HDATA)
endpoint = endpoints.TCP4ServerEndpoint(reactor, 8068)
endpoint.listen(server.Site(root))
reactor.listenUDP(42068, UDPData(HDATA, ("127.0.0.1", 42069)))
loop = task.LoopingCall(runEveryTick)
loopDeferred = loop.start(TICKLENGTH)
reactor.run()
