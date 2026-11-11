// LightCraft (MIT). See ENGINE_EVALUATION/LICENSE-LightCraft.txt.
// Compose linear sRGB → Rec.2020 → XYZ → LMS into one matrix.
const TO_LMS = [[0.4121764592172327,0.5362739742937673,0.0514403723146077],[0.21190919961508367,0.6807178710130037,0.10739984391238905],[0.08834481407142164,0.281853963111285,0.6302808687803242]];
const TO_LAB = [[.2104542553,.793617785,-.0040720468],[1.9779984951,-2.428592205,.4505937099],[.0259040371,.7827717662,-.808675766]];
function invert(m) {
  const [a,b,c] = m;
  const cross = (x,y) => [x[1]*y[2]-x[2]*y[1], x[2]*y[0]-x[0]*y[2], x[0]*y[1]-x[1]*y[0]];
  const columns = [cross(b,c),cross(c,a),cross(a,b)];
  const determinant = a.reduce((sum,value,i) => sum+value*columns[0][i],0);
  return a.map((_,i) => columns.map(col => col[i]/determinant));
}
const FROM_LMS = invert(TO_LMS);
const FROM_LAB = invert(TO_LAB);
const mul = (m, v) => m.map(([a,b,c]) => a*v[0]+b*v[1]+c*v[2]);
const toLab = rgb => mul(TO_LAB, mul(TO_LMS,rgb).map(Math.cbrt));
const skinLab = toLab([1,((25/60+.055)/1.055)**2.4,0]);
const skinHue = Math.atan2(skinLab[2], skinLab[1]);
const LUMA = [.2126,.7152,.0722];

export function colorPort(r,g,b,amount) {
  if (amount === 0) return [r,g,b];
  const [l,a,c] = toLab([r,g,b]);
  let factor = 1 + amount;
  if (amount > 0) {
    const low = 1 - Math.min(1, Math.sqrt(a*a+c*c)/.22);
    let delta = Math.atan2(c,a) - skinHue;
    delta -= Math.floor((delta+Math.PI)/(2*Math.PI))*2*Math.PI;
    const skin = 1 - .6 * Math.exp(-((delta/.35)**2));
    factor = 1 + amount * low * low * skin * 1.2;
  }
  const rgb = mul(FROM_LMS,mul(FROM_LAB,[l,a*factor,c*factor]).map(v => v*v*v));
  const y = Math.min(1, Math.max(0,LUMA.reduce((sum,w,i)=>sum+w*rgb[i],0)));
  let t=1;
  for (const v of rgb) {
    if (v<0) t=Math.min(t,y/Math.max(y-v,1e-9));
    else if (v>1) t=Math.min(t,(1-y)/Math.max(v-y,1e-9));
  }
  return t<1 ? rgb.map(v=>y+(v-y)*t) : rgb;
}
const matrix = m => 'mat3('+m.flatMap((_,i)=>m.map(row=>row[i].toFixed(11))).join(',')+')';
export const LIGHTCRAFT_GLSL = `
vec3 colorPort(vec3 rgb) {
  if (uColorAmount == 0.0) return rgb;
  vec3 lms = ${matrix(TO_LMS)} * rgb;
  vec3 lab = ${matrix(TO_LAB)} * (sign(lms) * pow(abs(lms),vec3(1.0/3.0)));
  float factor = 1.0 + uColorAmount;
  if (uColorAmount > 0.0) {
    float low = 1.0 - clamp(length(lab.yz)/0.22,0.0,1.0);
    float hue = lab.y == 0.0 && lab.z == 0.0 ? 0.0 : atan(lab.z,lab.y);
    float delta = mod(hue-${skinHue.toFixed(11)}+3.141592653589793,6.283185307179586)-3.141592653589793;
    float skin = 1.0 - 0.6*exp(-delta*delta/(0.35*0.35));
    factor = 1.0 + uColorAmount * low * low * skin * 1.2;
  }
  lab.yz *= factor;
  lms = ${matrix(FROM_LAB)} * lab;
  rgb = ${matrix(FROM_LMS)} * (lms*lms*lms);
  float y = clamp(dot(rgb,vec3(0.2126,0.7152,0.0722)),0.0,1.0);
  float low = min(rgb.r,min(rgb.g,rgb.b));
  float high = max(rgb.r,max(rgb.g,rgb.b));
  float t = 1.0;
  if (low < 0.0) t = min(t,y/max(y-low,1e-9));
  if (high > 1.0) t = min(t,(1.0-y)/max(high-y,1e-9));
  return t < 1.0 ? vec3(y)+(rgb-vec3(y))*t : rgb;
}
`;
