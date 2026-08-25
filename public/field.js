/* The ground SocialRise sits on.

   Domain-warped fractal noise rendered to a full-bleed canvas. A CSS
   gradient cannot warp itself or respond to a cursor, which is the whole
   difference between depth and a blurred blob.

   Renders at half resolution because noise is fill-rate bound — at this
   softness the difference is invisible and the cost is a quarter. Falls
   back to a static gradient wherever WebGL is unavailable, and freezes on
   a single frame under reduced-motion rather than running a loop nobody
   asked for. */
(function(){
  var host = document.getElementById('field');
  if (!host) return;

  var fallback = document.getElementById('field-fallback');
  var still = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function giveUp(){
    host.style.display = 'none';
    if (fallback) fallback.style.display = '';
  }

  var gl;
  try {
    gl = host.getContext('webgl', { antialias:false, alpha:true, powerPreference:'low-power' })
      || host.getContext('experimental-webgl');
  } catch (e){ /* some browsers throw rather than return null */ }
  if (!gl) return giveUp();

  if (fallback) fallback.style.display = 'none';

  var FRAG = [
    'precision highp float;',
    'uniform vec2 u_res; uniform float u_time; uniform vec2 u_mouse;',
    'float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}',
    'float noise(vec2 p){',
    ' vec2 i=floor(p),f=fract(p); vec2 u=f*f*(3.-2.*f);',
    ' return mix(mix(hash(i),hash(i+vec2(1,0)),u.x),',
    '            mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y);}',
    'float fbm(vec2 p){float v=0.,a=.5;',
    ' for(int i=0;i<5;i++){v+=a*noise(p);p*=2.02;a*=.5;} return v;}',
    'void main(){',
    ' vec2 uv=(gl_FragCoord.xy-.5*u_res)/u_res.y;',
    ' float t=u_time*.045;',
    ' uv+=(u_mouse-.5)*.16;',
    // two rounds of domain warp — this is where the depth comes from
    ' vec2 q=vec2(fbm(uv*1.5+t), fbm(uv*1.5+vec2(5.2,1.3)-t));',
    ' vec2 r=vec2(fbm(uv*1.8+q*2.4+vec2(1.7,9.2)+t*1.4),',
    '             fbm(uv*1.8+q*2.4+vec2(8.3,2.8)-t*1.1));',
    ' float f=fbm(uv*1.6+r*2.2);',
    // Cyber: deep ocean ground, cyan through blue into lime
    ' vec3 col=vec3(.016,.051,.078);',
    ' col=mix(col,vec3(.000,.835,1.000),smoothstep(.28,.86,f)*.60);',
    ' col=mix(col,vec3(.180,.608,.961),smoothstep(.48,.95,length(r))*.50);',
    ' col=mix(col,vec3(.639,.902,.208),smoothstep(.66,1.10,q.x+f*.55)*.26);',
    // light gathers toward the top so the headline sits in shadow
    ' col*=mix(.30,1.16,smoothstep(.95,-.30,uv.y+.14));',
    ' col*=1.-.52*smoothstep(.40,1.25,length(uv*vec2(.82,1.)));',
    ' gl_FragColor=vec4(col,1.);}'
  ].join('\n');

  function compile(type, src){
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  }

  var vs = compile(gl.VERTEX_SHADER, 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}');
  var fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return giveUp();

  var prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return giveUp();
  gl.useProgram(prog);

  var buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
  var loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  var uRes = gl.getUniformLocation(prog, 'u_res'),
      uTime = gl.getUniformLocation(prog, 'u_time'),
      uMouse = gl.getUniformLocation(prog, 'u_mouse');

  function resize(){
    var w = Math.max(1, Math.floor(innerWidth * 0.5));
    var h = Math.max(1, Math.floor(innerHeight * 0.5));
    host.width = w; host.height = h;
    gl.viewport(0, 0, w, h);
    gl.uniform2f(uRes, w, h);
  }
  addEventListener('resize', resize, { passive:true });
  resize();

  var mx = .5, my = .5, tmx = .5, tmy = .5;
  addEventListener('pointermove', function(e){
    tmx = e.clientX / innerWidth;
    tmy = 1 - e.clientY / innerHeight;
  }, { passive:true });

  /* Stop drawing when the tab is hidden — a background tab painting a
     noise field every frame is a battery leak nobody sees. */
  var visible = true;
  document.addEventListener('visibilitychange', function(){
    visible = !document.hidden;
    if (visible && !still) requestAnimationFrame(frame);
  });

  var start = performance.now();

  function frame(now){
    // ease toward the pointer so the field drifts rather than snaps
    mx += (tmx - mx) * .045;
    my += (tmy - my) * .045;
    gl.uniform1f(uTime, (now - start) / 1000);
    gl.uniform2f(uMouse, mx, my);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (visible) requestAnimationFrame(frame);
  }

  if (still){
    // one frame, held: the look without the motion
    gl.uniform1f(uTime, 6);
    gl.uniform2f(uMouse, .5, .5);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  } else {
    requestAnimationFrame(frame);
  }
})();
