// Keep the browser/proxy connection alive throughout one journaled operation.
async function proxyDiaryStream(res, url, options, { heartbeatMs = 5000, onEvent, job } = {}) {
  const controller = new AbortController();
  const close = () => { if (!res.writableEnded && !job) controller.abort(); };
  res.on('close', close);
  res.on('error', () => {});
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
  const send = event => { job?.event(event); if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`); };
  const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keep-alive\n\n'); }, heartbeatMs);
  const deadline = setTimeout(() => controller.abort(), 15 * 60 * 1000);
  try {
    send({type:'status',text:'Connecting to diary companion…'});
    const upstream = await fetch(url, {...options, signal:controller.signal});
    if (!upstream.ok || !upstream.body) throw new Error('Diary upstream unavailable');
    if ((upstream.headers.get('content-type') || '').includes('text/event-stream')) {
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of upstream.body) {
        if (res.destroyed && !job) break;
        buffer += decoder.decode(chunk, {stream:true});
        let boundary;
        // Heartbeats must never be inserted inside a fragmented JSON event.
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const frame=buffer.slice(0,boundary + 2);
          if(onEvent){try{const line=frame.split('\n').find(l=>l.startsWith('data: '));if(line)onEvent(JSON.parse(line.slice(6)));}catch{ /* Optional telemetry must never break diary capture. */ }}
          if(job){const line=frame.split('\n').find(l=>l.startsWith('data: '));if(line)job.event(JSON.parse(line.slice(6)));}
          if(!res.destroyed)res.write(frame);
          buffer = buffer.slice(boundary + 2);
        }
      }
      if (buffer.trim() && (!res.destroyed || job)) throw new Error('Incomplete diary stream');
    } else {
      // Compatibility with a previous sidecar during a rolling upgrade.
      const full = await upstream.json(), choice = full.choices?.[0]?.message;
      if (choice) {
        if (choice.reasoning_content) send({type:'reasoning',text:choice.reasoning_content});
        if (!choice.content) throw new Error('No companion answer');
        send({type:'answer',text:choice.content});
        send({type:'diary',...full.diary});
      } else {
        if (typeof full.reply !== 'string') throw new Error('No companion answer');
        if (full.reasoning) send({type:'reasoning',text:full.reasoning});
        send({type:'answer',text:full.reply});
        send({type:'diary',...full});
      }
      send({type:'done'});
    }
  } catch {
    try { send({type:'error',text:'The diary connection was interrupted. The entry may still be saving; check the saved diary before sending again.'}); } catch { /* Failed recovery storage must not turn into an unhandled rejection. */ }
  } finally {
    clearInterval(heartbeat); clearTimeout(deadline); res.off('close', close);
    try { job?.finish(); } catch { /* A running record will recover as uncertain after restart. */ }
    if (!res.destroyed) res.end();
  }
}
module.exports = {proxyDiaryStream};
