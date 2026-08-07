import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {access} from "node:fs/promises";

const read=path=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("entrypoint contains accessibility and security essentials",async()=>{
  const html=await read("index.html");
  assert.match(html,/Content-Security-Policy/);
  assert.doesNotMatch(html,/maximum-scale=1/);
  assert.match(html,/role="dialog"/);
  assert.match(html,/aria-live="polite"/);
  assert.match(html,/src="\.\/src\/app\.js"/);
});

test("application source keeps the production point contract centralized",async()=>{
  const config=await read("src/config.js");
  assert.match(config,/POINT_DEFINITIONS/);
  assert.match(config,/Object\.freeze/);
});

test("all service worker assets exist",async()=>{
  for(const path of [
    "index.html","styles.css","manifest.webmanifest","src/config.js","src/domain.js",
    "src/storage.js","src/app.js","icon-192.png","icon-512.png","icon-maskable-512.png"
  ]) await access(new URL(`../${path}`,import.meta.url));
});

test("service worker does not force updates during editing",async()=>{
  const sw=await read("sw.js");
  const installBlock=sw.match(/self\.addEventListener\("install",[\s\S]*?\n}\);/)?.[0] || "";
  assert(installBlock);
  assert.equal(installBlock.includes("skipWaiting()"),false);
  assert.match(sw,/SKIP_WAITING/);
  assert.match(sw,/AbortController/);
});


test("PWA cache version matches application version",async()=>{
  const config=await read("src/config.js");
  const sw=await read("sw.js");
  const appVersion=config.match(/APP_VERSION = "([^"]+)"/)?.[1];
  const swVersion=sw.match(/VERSION="([^"]+)"/)?.[1];
  assert.ok(appVersion);
  assert.equal(swVersion,appVersion);
});

test("manifest does not force portrait orientation",async()=>{
  const manifest=JSON.parse(await read("manifest.webmanifest"));
  assert.equal(Object.hasOwn(manifest,"orientation"),false);
});
