// Ticks for a call recording. A page's own animation frames stop while its tab is in the
// background, which froze the recorded video; timers in a worker keep running there.
let timer = null;
self.onmessage = ({ data }) => {
  clearInterval(timer);
  if (data > 0) timer = setInterval(() => self.postMessage(0), data);
};
