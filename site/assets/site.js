(() => {
  // Keep the mobile navigation visible if this script cannot load or run.
  document.documentElement.classList.add('js');
  const menuButton=document.querySelector('.menu-toggle');
  const nav=document.getElementById('site-nav');
  if(menuButton&&nav){
    menuButton.addEventListener('click',()=>{
      const open=menuButton.getAttribute('aria-expanded')!=='true';
      menuButton.setAttribute('aria-expanded',String(open));
      nav.classList.toggle('is-open',open);
    });
    nav.addEventListener('click',(event)=>{
      if(event.target.closest('a')){
        menuButton.setAttribute('aria-expanded','false');
        nav.classList.remove('is-open');
      }
    });
    document.addEventListener('keydown',(event)=>{
      if(event.key==='Escape'&&nav.classList.contains('is-open')){
        menuButton.setAttribute('aria-expanded','false');
        nav.classList.remove('is-open');
        menuButton.focus();
      }
    });
  }
  const copyText=async(text)=>{
    if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(text);return;}
    const field=document.createElement('textarea');
    field.value=text;field.setAttribute('readonly','');field.style.position='fixed';field.style.opacity='0';
    document.body.append(field);field.select();
    const copied=document.execCommand('copy');field.remove();
    if(!copied)throw new Error('Clipboard is unavailable in this browser.');
  };
  document.querySelectorAll('[data-copy]').forEach((button)=>{
    button.addEventListener('click',async()=>{
      const original=button.textContent;
      try{await copyText(button.getAttribute('data-copy')||'');button.textContent='Copied';}
      catch{button.textContent='Copy unavailable';}
      button.disabled=true;
      window.setTimeout(()=>{button.textContent=original;button.disabled=false;},1800);
    });
  });
})();
