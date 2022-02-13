from queue import PriorityQueue
from time import time

class Bridge:
    queue = PriorityQueue(500)
    stats = {}
    udpsend = None
    spam = False
    origtime = 0

    @classmethod
    def shorttime(CLS):
        return int((time()-CLS.origtime)*1000)
