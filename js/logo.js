/* Shows the optional header logo (img/logo.svg) only once it has actually loaded; a missing file stays hidden. */
(function () {
  var img = document.querySelector('.hero .logo'); if (!img) return;
  function ok() { img.closest('.hero').classList.add('has-logo'); }
  function gone() { if (img.parentNode) img.parentNode.removeChild(img); }
  if (img.complete) { if (img.naturalWidth > 0) ok(); else gone(); }
  else { img.addEventListener('load', ok); img.addEventListener('error', gone); }
})();
