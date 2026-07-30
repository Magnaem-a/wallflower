// Stub-DOM smoke test. Loads the script and runs it through DOMContentLoaded to
// catch missing declarations, which a syntax check cannot see.
var handlers = {};
var stub = new Proxy({}, {
  get: function (t, k) {
    if (k === 'style') return {};
    if (k === 'dataset') return {};
    if (k === 'classList') return { toggle(){}, add(){}, remove(){} };
    if (k === 'getBoundingClientRect') return () => ({left:0,top:0,width:100,height:200,right:100,bottom:200});
    if (k === 'querySelector') return () => stub;
    if (k === 'querySelectorAll') return () => [];
    if (k === 'cloneNode') return () => stub;
    if (k === 'getAttribute') return () => 'x.png';
    if (k === 'textContent') return '12';
    return () => stub;
  }
});
global.window = { $memberstackDom: null, location: { search: '', reload(){} }, addEventListener(){} };
global.document = {
  querySelector: () => stub,
  querySelectorAll: () => [],
  createElement: () => ({ width:0, height:0, getContext: () => ({ drawImage(){}, getImageData: () => ({data:new Uint8Array(4)}) }) }),
  addEventListener: (e, fn) => { handlers[e] = fn; }
};
global.Image = function(){};
require('./public/wallflower.js');
Promise.resolve(handlers.DOMContentLoaded && handlers.DOMContentLoaded())
  .then(() => console.log('PASS: ran through DOMContentLoaded with no ReferenceError'))
  .catch(e => { console.log('FAIL:', e.constructor.name, e.message); process.exit(1); });
