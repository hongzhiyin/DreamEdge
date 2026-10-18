export const webPolicy = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
export const pairingPage = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>连接 DreamEdge</title><link rel="stylesheet" href="/aurora-tokens.css"><link rel="stylesheet" href="/web.css"></head>
<body class="web-pair"><main>
  <p>DreamEdge</p><h1>连接本机对话</h1>
  <p>在 DreamEdge 桌面端启用网页访问，输入刚生成的配对码。</p>
  <form>
    <label for="code">一次性配对码</label>
    <input id="code" name="code" autocomplete="off" spellcheck="false" required maxlength="64">
    <button>连接</button><p role="status" id="status"></p>
  </form>
  <p>连接后可使用本机已有会话与工具权限。配对码五分钟内有效，仅可使用一次。</p>
</main><script src="/pair.js"></script></body></html>`;
export const pairingScript = `document.querySelector('form').addEventListener('submit', async event => {
 event.preventDefault();const button=document.querySelector('button'),status=document.querySelector('#status');
 button.disabled=true;status.textContent='正在连接…';
 try {const response=await fetch('/api/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:document.querySelector('#code').value.trim()})});
 if(response.ok){const paired=await response.json();localStorage.setItem('dreamedge:web-csrf',paired.csrf);location.replace('/');return;}status.textContent='配对码无效或已过期，请在桌面端重新生成。';}
 catch{status.textContent='无法连接本机 DreamEdge，请确认应用仍在运行。';}finally{button.disabled=false;}
});`;
export const webStyles = `
.web-pair {margin:0;min-height:100vh;box-sizing:border-box;padding:48px 16px;
  background:var(--aurora-background);color:var(--text);font:15px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
  -webkit-font-smoothing:antialiased;color-scheme:light;}
.web-pair *{box-sizing:border-box;}
.web-pair main{max-width:440px;padding:28px;margin:auto;background:var(--glass);
  backdrop-filter:var(--glass-filter);border:1px solid var(--glass-border);border-radius:25px;box-shadow:var(--shadow-overlay);}
.web-pair h1{font-size:24px;line-height:1.4;font-weight:500;letter-spacing:-.5px;text-wrap:balance;}
.web-pair main>p:first-child{font-weight:600;color:var(--accent);}
.web-pair label{display:block;margin-bottom:8px;font-size:13px;}
.web-pair input{width:100%;min-height:44px;padding:12px;border:1px solid var(--border);border-radius:9px;
  font:inherit;color:var(--text);background:var(--glass-input);}
.web-pair button{margin-top:16px;padding:10px 22px;border:0;border-radius:10px;background:var(--accent);
  color:var(--on-accent);font:inherit;min-height:44px;cursor:pointer;transition:background-color 140ms;}
.web-pair button:hover:not(:disabled){background:var(--accent-hover);}
.web-pair button:disabled{background:var(--disabled-surface);color:var(--disabled-text);cursor:default;}
.web-pair :focus-visible{outline:2px solid var(--ring);outline-offset:3px;}
.web-pair p{color:var(--secondary);font-size:13px;overflow-wrap:anywhere;text-wrap:pretty;}
.web-pair #status{min-height:24px;color:var(--error);}
@media(max-width:440px){.web-pair{padding:24px 12px;}.web-pair main{padding:22px 18px;}}
@media(prefers-reduced-motion:reduce){.web-pair button{transition:none;}}
`;
export function browserIndex(source: string) {
  return source.replace(/<meta\s+[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '')
    .replace('<head>', '<head><script src="/web-bridge.js"></script>')
    .replace('</head>', '<link rel="stylesheet" href="/web.css"></head>');
}
