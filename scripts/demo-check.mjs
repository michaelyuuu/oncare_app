const targets = [["api", "http://127.0.0.1:3000/health"], ["resident", "http://127.0.0.1:5173/"], ["family", "http://127.0.0.1:5174/"]];
for (const [name, url] of targets) {
  try { const r = await fetch(url); console.log(`${name.padEnd(9)} ${r.ok ? "up" : `http ${r.status}`}  ${url}`); }
  catch { console.log(`${name.padEnd(9)} DOWN ${url}`); }
}
