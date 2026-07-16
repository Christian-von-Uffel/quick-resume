(function(){
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---- nav shadow ---- */
  var nav = document.getElementById('nav');
  window.addEventListener('scroll', function(){
    nav.classList.toggle('scrolled', window.scrollY > 8);
  }, {passive:true});

  /* ---- scroll reveal ---- */
  var revealer = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if(e.isIntersecting){ e.target.classList.add('in-view'); revealer.unobserve(e.target); }
    });
  }, {threshold:.15, rootMargin:'0px 0px -40px 0px'});
  document.querySelectorAll('[data-animate]').forEach(function(el){ revealer.observe(el); });

  /* ---- FAQ: one open at a time ---- */
  var faqs = document.querySelectorAll('.faq-item');
  faqs.forEach(function(d){
    d.addEventListener('toggle', function(){
      if(d.open) faqs.forEach(function(o){ if(o!==d) o.open=false; });
    });
  });

  /* ============ CLARITY REVIEW DEMO ============ */
  var clDemo = document.getElementById('clarityDemo');
  if(clDemo){
    var clText = document.getElementById('clText'),
        clBullet = document.getElementById('clBullet'),
        clFlag = document.getElementById('clFlag'),
        clOpts = document.getElementById('clOpts'),
        clRewrite = document.getElementById('clRewrite'),
        clRwText = document.getElementById('clRwText'),
        clHint = document.getElementById('clHint'),
        clReset = document.getElementById('clReset');
    var ORIGINAL = '"Responsible for various data-related initiatives across multiple teams"';
    var REWRITES = {
      '1': '"Built dashboards and reports adopted by 5 teams as their daily source of truth"',
      '2': '"Led end-to-end data projects across 4 teams, from scoping through delivery"',
      '3': '"Maintained and hardened the data pipelines behind company-wide reporting"',
      'other': '"You describe it in your own words — then we suggest sharper phrasing"'
    };
    var interacted = false, timers = [];
    function later(fn, ms){ timers.push(setTimeout(fn, ms)); }
    function clearTimers(){ timers.forEach(clearTimeout); timers = []; }

    function selectOpt(key){
      clOpts.querySelectorAll('.cl-opt').forEach(function(b){
        b.classList.toggle('selected', b.dataset.opt === key);
      });
      clRwText.textContent = REWRITES[key];
      clRewrite.classList.add('show');
    }
    function accept(){
      clText.textContent = clRwText.textContent;
      clBullet.classList.add('improved','flash');
      clFlag.textContent = '✓ Clear';
      clRewrite.classList.remove('show');
      clReset.classList.add('show');
      setTimeout(function(){ clBullet.classList.remove('flash'); }, 950);
    }
    function resetDemo(){
      clText.textContent = ORIGINAL;
      clBullet.classList.remove('improved','flash');
      clFlag.textContent = 'Needs clarity';
      clRewrite.classList.remove('show');
      clReset.classList.remove('show');
      clOpts.querySelectorAll('.cl-opt').forEach(function(b){ b.classList.remove('selected'); });
    }

    clOpts.addEventListener('click', function(e){
      var btn = e.target.closest('.cl-opt'); if(!btn) return;
      stopAuto(); resetBullet(); selectOpt(btn.dataset.opt);
    });
    function resetBullet(){
      if(clBullet.classList.contains('improved')){
        clText.textContent = ORIGINAL;
        clBullet.classList.remove('improved');
        clFlag.textContent = 'Needs clarity';
        clReset.classList.remove('show');
      }
    }
    document.getElementById('clAccept').addEventListener('click', function(){ stopAuto(); accept(); });
    document.getElementById('clReject').addEventListener('click', function(){
      stopAuto(); clRewrite.classList.remove('show');
      clOpts.querySelectorAll('.cl-opt').forEach(function(b){ b.classList.remove('selected'); });
    });
    clReset.addEventListener('click', function(){ stopAuto(); resetDemo(); });

    function stopAuto(){
      if(!interacted){
        interacted = true; clearTimers();
        clHint.textContent = 'Nice — you’re in control. Accept swaps the phrasing; reject keeps yours.';
      }
    }
    function autoCycle(){
      if(interacted || reduced) return;
      resetDemo();
      later(function(){ if(!interacted) selectOpt('2'); }, 5000);
      later(function(){ if(!interacted) accept(); }, 11000);
      later(function(){ if(!interacted) autoCycle(); }, 18000);
    }
    var clObs = new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        if(e.isIntersecting){ clObs.disconnect(); later(autoCycle, 800); }
      });
    }, {threshold:.35});
    clObs.observe(clDemo);
  }

  /* ============ GAP REVIEW DEMO ============ */
  var gapDemo = document.getElementById('gapDemo');
  if(gapDemo){
    var ring = document.getElementById('gapRing'),
        scoreEl = document.getElementById('gapScore'),
        req1 = document.getElementById('gapReq1'),
        req2 = document.getElementById('gapReq2'),
        prompt = document.getElementById('gapPrompt'),
        promptText = document.getElementById('gapPromptText');
    var C = 188.5;
    var current = 68;
    function setScore(target){
      var from = current, start = null;
      current = target;
      function frame(ts){
        if(!start) start = ts;
        var p = Math.min((ts - start) / 700, 1);
        var eased = 1 - Math.pow(1 - p, 3);
        var val = Math.round(from + (target - from) * eased);
        scoreEl.textContent = val + '%';
        if(p < 1) requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
      ring.style.strokeDashoffset = (C * (1 - target / 100)).toFixed(1);
      ring.style.stroke = target >= 90 ? 'var(--green)' : (target >= 80 ? 'var(--blue)' : 'var(--amber)');
    }
    function setReq(el, ok){
      el.classList.toggle('ok', ok);
      el.classList.toggle('warn', !ok);
      el.querySelector('.st').textContent = ok ? '✓' : '!';
    }
    var MSG1 = 'You mentioned leading the <b>HIPAA compliance project</b> at Novara — that’s healthcare experience. Add it to this resume?';
    var MSG2 = 'You wrote that you <b>built the analytics stack</b> at DataCore — that covers SQL &amp; analytics. Add it?';
    function gapCycle(){
      if(reduced){ setReq(req1,true); setReq(req2,true); setScore(94); return; }
      setReq(req1,false); setReq(req2,false); setScore(68); prompt.classList.remove('show');
      var t = [];
      t.push(setTimeout(function(){ promptText.innerHTML = MSG1; prompt.classList.add('show'); }, 2500));
      t.push(setTimeout(function(){ prompt.classList.remove('show'); setReq(req1,true); setScore(82); }, 9000));
      t.push(setTimeout(function(){ promptText.innerHTML = MSG2; prompt.classList.add('show'); }, 10500));
      t.push(setTimeout(function(){ prompt.classList.remove('show'); setReq(req2,true); setScore(94); }, 17000));
      t.push(setTimeout(gapCycle, 22000));
    }
    ring.style.stroke = 'var(--amber)';
    var gapObs = new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        if(e.isIntersecting){ gapObs.disconnect(); setTimeout(gapCycle, 600); }
      });
    }, {threshold:.35});
    gapObs.observe(gapDemo);
  }
})();
