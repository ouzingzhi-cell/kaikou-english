const digits = ['zero','one','two','three','four','five','six','seven','eight','nine'];
const small = ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
function number(n) {
  n=Number(n);
  if (n<20) return small[n];
  if (n<100) return ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'][Math.floor(n/10)] + (n%10?' '+small[n%10]:'');
  return String(n).split('').map(n=>digits[Number(n)]).join(' ');
}

/** English-only spoken forms prevent a Chinese/default voice interpreting numbers. */
export function spokenEnglish(text) {
  return text.replace(/[’‘]/g,"'")
    .replace(/\bMr\.\s*/gi,'Mister ').replace(/\bMrs\.\s*/gi,'Missus ').replace(/\bMs\.\s*/gi,'Miz ').replace(/\bDr\.\s*/gi,'Doctor ')
    .replace(/\bRoom\s*(\d{2,5})\b/gi,(_,n)=>'room '+n.split('').map(c=>digits[Number(c)]).join(' '))
    .replace(/\b(\d{1,2}):(\d{2})\b/g,(_,h,m)=>number(h)+(m==='00'?'':` ${m.startsWith('0')?'oh ':''}${number(m)}`))
    .replace(/\b(\d{1,2})\s*a\.m\.?/gi,(_,n)=>`${number(n)} A M`)
    .replace(/\b(\d{1,2})\s*p\.m\.?/gi,(_,n)=>`${number(n)} P M`)
    .replace(/\ba\.m\.?/gi,'A M').replace(/\bp\.m\.?/gi,'P M')
    .replace(/\bID\b/g,'eye dee')
    .replace(/^a$/i,'uh');
}

export function pronunciationChecks(text) {
  const checks=[];
  if (/\b(?:Mr|Mrs|Ms|Dr)\./i.test(text)) checks.push('honorific');
  if (/\b\d+\s*[ap]\.m\./i.test(text)) checks.push('time');
  if (/\broom\s*\d+/i.test(text)) checks.push('room-number');
  if (/\b(?:here|there|that|it|what)[’']s\b/i.test(text)) checks.push('contraction');
  if (/\ba\s+[a-z]/i.test(text)) checks.push('weak-article');
  return {checks, spoken:spokenEnglish(text)};
}
