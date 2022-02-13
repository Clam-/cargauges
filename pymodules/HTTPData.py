from json import load, dumps
import time
from twisted.web import resource
from .Bridge import Bridge

class HTTPData(resource.Resource):
    isLeaf = True

    def __init__(self):
        self.stats = Bridge.stats
        self.lastsend = time.time()

    def render_POST(self, request):
        s = load(request.content) # receive [key, data]
        if Bridge.PACKET_SPAM:
            Bridge.udpsend({s[0]:s[1], "T": Bridge.shorttime()})
        else:
            self.stats[s[0]] = s[1]
            t = time.time()
            if t > self.lastsend+1:
                stats["T"] = Bridge.shorttime()
                self.lastsend = t
                Bridge.udpsend()
        return b"Done."

    def render_GET(self, request):
        request.setHeader(b"content-type", b"application/json")
        # this should dump the stats it has collected and then clear them so stats
        # aren't resent.
        content = dumps(self.stats).encode("utf-8")
        self.stats.clear()
        return content
