"use strict";
// SPIKE: same-origin reverse proxy for the Videasy player, to test whether
// serving Videasy same-origin (with spoofed upstream Referer/Origin) defeats its
// embedding lock so its WASM decryptor produces a stream. NOT production-grade.
//
//   /vzy/p/<path>  -> player.videasy.to     (the player SPA)
//   /vzy/a/<path>  -> api.videasy.to         (encrypted sources API)
//   /vzy/d/<path>  -> db.videasy.to          (metadata)
//   /vzy/u/<path>  -> users.videasy.to       (telemetry)
//
// Test URL: https://<host>/vzy/p/movie/550

const HOSTS = {
  p: "player.videasy.to",
  a: "api.videasy.to",
  d: "db.videasy.to",
  u: "users.videasy.to",
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Injected at the top of <head>: rewrites any videasy host that dynamic JS
// builds at runtime (fetch/XHR) back to the same-origin /vzy prefixes, since a
// static text rewrite can't catch URLs assembled in code.
const SHIM = `(function(){
  var M={"player.videasy.to":"/vzy/p","api.videasy.to":"/vzy/a","db.videasy.to":"/vzy/d","users.videasy.to":"/vzy/u"};
  function rw(u){try{if(typeof u!=="string")return u;
    for(var h in M){u=u.split("https://"+h).join(location.origin+M[h]).split("http://"+h).join(location.origin+M[h]).split("//"+h).join(M[h]);}
    // root-relative paths on this (proxied) page belong to the player -> /vzy/p
    if(u.charAt(0)==="/"&&u.indexOf("/vzy/")!==0)u="/vzy/p"+u;
    return u;}catch(e){return u;}}
  var of=window.fetch;window.fetch=function(i,init){try{if(i&&typeof i==="object"&&i.url){i=new Request(rw(i.url),i);}else{i=rw(i);}}catch(e){}return of.call(this,i,init);};
  var xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){try{arguments[1]=rw(u);}catch(e){}return xo.apply(this,arguments);};
})();`;

function rewriteText(text, isHtml) {
  // absolute + protocol-relative videasy hosts
  for (const [h, host] of Object.entries(HOSTS)) {
    text = text.split(`https://${host}`).join(`/vzy/${h}`).split(`//${host}`).join(`/vzy/${h}`);
  }
  // root-relative player asset paths (delimiter-anchored so we don't rewrite
  // arbitrary "/…" strings). Next.js publicPath "/_next/" is a bare string in
  // the runtime, so rewrite it unanchored too.
  text = text
    .replace(/(["'(=,`])\/_next\//g, "$1/vzy/p/_next/")
    .replace(/(["'(=,`])\/module\.wasm/g, "$1/vzy/p/module.wasm")
    .replace(/(["'(=,`])\/manifest\.(js|json)/g, "$1/vzy/p/manifest.$2")
    .replace(/(["'(=,`])\/scripts\//g, "$1/vzy/p/scripts/")
    .replace(/(["'(=,`])\/favicon\.ico/g, "$1/vzy/p/favicon.ico")
    .replace(/(["'(=,`])\/cdn-cgi\//g, "$1/vzy/p/cdn-cgi/");
  return text;
}

module.exports = async function (fastify) {
  fastify.all("/:h/*", async (req, reply) => {
    const host = HOSTS[req.params.h];
    if (!host) return reply.code(404).send("unknown videasy host");
    const rest = req.params["*"] || "";
    const q = req.raw.url.indexOf("?");
    const qs = q >= 0 ? req.raw.url.slice(q) : "";
    const target = `https://${host}/${rest}${qs}`;

    let res;
    try {
      res = await fetch(target, {
        method: req.method === "HEAD" ? "GET" : req.method,
        headers: {
          "User-Agent": UA,
          Referer: "https://player.videasy.to/",
          Origin: "https://player.videasy.to",
          Accept: req.headers["accept"] || "*/*",
          "Accept-Language": req.headers["accept-language"] || "en-US,en;q=0.9",
        },
        redirect: "follow",
      });
    } catch (e) {
      return reply.code(502).send("vzy proxy fetch failed: " + e.message);
    }

    const ct = res.headers.get("content-type") || "application/octet-stream";
    reply.header("content-type", ct);
    reply.header("cache-control", "no-store");
    // Note: we deliberately drop upstream CSP / X-Frame-Options / COOP / COEP /
    // content-encoding by only setting content-type ourselves.

    const isText = /text\/|javascript|json|xml|application\/x-mpegurl|mpegurl/i.test(ct);
    if (isText) {
      const isHtml = /text\/html/i.test(ct);
      let text = rewriteText(await res.text(), isHtml);
      if (isHtml) {
        text = text.replace(/<head([^>]*)>/i, (m) => `${m}<script>${SHIM}</script>`);
      }
      return reply.send(text);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return reply.send(buf);
  });
};
