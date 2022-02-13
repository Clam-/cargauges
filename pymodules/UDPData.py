from json import loads, dumps
from twisted.internet.protocol import DatagramProtocol
from .Bridge import Bridge

class UDPData(DatagramProtocol):

    def __init__(self, hdata, ip=None):
        self.stats = Bridge.stats
        self.ip = ip
        self.queue = Bridge.queue
        Bridge.udpsend = self.udpsend
        super().__init__()

    def datagramReceived(self, packet, addr):
        # this needs to go in to the priority queue so it can be popped off in
        # a correct "playback" order.
        # ignore normal data until we see origtime.
        data = loads(packet.decode("utf-8"))
        if Bridge.origtime is 0:
            if "OT" in data: Bridge.origtime = data["OT"]
        elif "T" in data:
            t = data.pop("T")
            self.queue.put((t,data))

    def udpsend(self, packet=None):
        if packet:
            self.transport.write(dumps(packet).encode("utf-8"), self.ip)
        else:
            self.transport.write(dumps(self.stats).encode("utf-8"), self.ip)
            self.stats.clear()
