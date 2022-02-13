import mimetypes
from twisted.web import static

mimetypes.add_type("text/javascript", ".js", strict=True)
mimetypes.add_type("text/html;charset=utf-8", ".html", strict=True)

FILE = static.File("static")
