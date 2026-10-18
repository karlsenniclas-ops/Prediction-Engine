import json
import mimetypes
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import webbrowser

import main
from app.service import Store

ROOT = Path(__file__).parent


def handler(store):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, value, status=200):
            self.respond(json.dumps(value, allow_nan=False).encode(), 'application/json', status)

        def respond(self, body, content_type, status=200):
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

        def do_GET(self):
            url = urlparse(self.path)
            args = {k: v[0] for k, v in parse_qs(url.query).items()}
            try:
                if url.path == '/api/status':
                    return self.send(store.status())
                if url.path == '/api/search':
                    return self.send(store.search(args.get('q', '')[:200]))
                if url.path in ('/api/detail', '/api/history'):
                    selection = (args['venue'], args['id'])
                    if url.path == '/api/history':
                        return self.send(store.histories(*selection))
                    return self.send(store.detail(*selection))
                files = {'/': 'index.html', '/app.js': 'app.js', '/charts.js': 'charts.js', '/style.css': 'style.css'}
                if url.path in files:
                    path = ROOT / files[url.path]
                    kind = 'text/javascript' if path.suffix == '.js' else mimetypes.guess_type(path.name)[0]
                    return self.respond(path.read_bytes(), kind + '; charset=utf-8')
                self.send({'error': 'Not found'}, 404)
            except KeyError:
                self.send({'error': 'Market not found'}, 404)
            except ValueError as exc:
                self.send({'error': str(exc)}, 400)
            except Exception:
                self.send({'error': 'Unable to load market data. Refresh to retry.'}, 500)

        def do_POST(self):
            host = self.headers.get('Host')
            if self.headers.get('Origin') != 'http://' + str(host) or host not in (f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'):
                return self.send({'error': 'Local requests only'}, 403)
            if self.path == '/api/rescan':
                store.rescan()
                return self.send(store.status())
            self.send({'error': 'Not found'}, 404)
    return Handler


def serve(port=8765, open_browser=True):
    data = main.load() if Path(main.SCAN).exists() else None
    store = Store(data)
    server = ThreadingHTTPServer(('127.0.0.1', port), handler(store))
    url = f'http://127.0.0.1:{server.server_port}'
    print(f'Prediction Engine · {url}', flush=True)
    if open_browser:
        webbrowser.open(url)
    if not data or time.time() - data['time'] > main.SCAN_TTL:
        store.rescan()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
