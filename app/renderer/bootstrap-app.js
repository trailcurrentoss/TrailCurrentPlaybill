/* App bootstrap — mounts the TVApp React component into #tv-root.
   Loaded last, after data, hooks, and all components have attached
   themselves to window. */

(function () {
  var root = ReactDOM.createRoot(document.getElementById('tv-root'));
  root.render(React.createElement(window.TVApp));
})();
