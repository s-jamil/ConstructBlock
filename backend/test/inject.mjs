import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";

// Exercise the real Node HTTP request/response classes without binding a TCP port.
// Express.json sets Content-Length; chunked responses are deliberately unsupported
// so transport assumptions fail explicitly rather than silently hiding test errors.
export function inject(handler, { method = "GET", url, body, headers: suppliedHeaders = {} }) {
  return new Promise((resolve, reject) => {
    const writes = [];
    const socket = new Duplex({ read() {}, write(chunk, _encoding, callback) {
      writes.push(Buffer.from(chunk)); callback();
    } });
    const req = new IncomingMessage(socket);
    req.method = method; req.url = url; req.headers = { host: "localhost", ...suppliedHeaders };
    if (body !== undefined) {
      const encoded = typeof body === "string" ? body : JSON.stringify(body);
      req.headers["content-type"] ??= "application/json";
      req.headers["content-length"] = String(Buffer.byteLength(encoded));
      req.push(Buffer.from(encoded));
    }
    req.complete = true; req.push(null);
    const res = new ServerResponse(req);
    res.assignSocket(socket);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`No HTTP response for ${url}`)); }, 2000);
    res.on("error", reject);
    res.on("finish", () => {
      clearTimeout(timer);
      const raw = Buffer.concat(writes), split = raw.indexOf("\r\n\r\n");
      const headers = res.getHeaders();
      socket.destroy();
      if (headers["transfer-encoding"]) return reject(new Error("Test injector does not support chunked responses"));
      resolve({ statusCode: res.statusCode, headers, payload: split === -1 ? "" : raw.subarray(split + 4).toString("utf8") });
    });
    try { handler(req, res); } catch (error) { clearTimeout(timer); socket.destroy(); reject(error); }
  });
}
