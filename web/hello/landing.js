'use strict';
const examples = {
 photo: {message:'I sketched a little idea. A shared space, a few raised beds, everyone welcome.',attachment:'⌁  garden-sketch.jpg',type:'A FIRST SKETCH',note:'Jules · just added',task:'Find community garden models',detail:'Turning the room’s ideas into a useful starting point.'},
 voice: {message:'“Let’s start with one garden, not a whole network. Somewhere we can all walk to.”',attachment:'◉  Voice note · illustrative transcript',type:'FROM THE CONVERSATION',note:'Jules · a thought, captured',task:'Explore a small pilot',detail:'Using the team’s shared context to shape the next step.'},
 text: {message:'First thought: partner with a local school. They have space, and we could learn together.',attachment:'↗  Idea added to the room',type:'A THOUGHT TO BUILD ON',note:'Jules · a new possibility',task:'Research potential partners',detail:'A question from the chat becomes work the team can follow.'},
 video: {message:'Here’s a quick walkthrough of the empty lot. Imagine what we could do with this corner.',attachment:'▷  site-walkthrough.mp4 · example',type:'A DIFFERENT PERSPECTIVE',note:'Jules · a place to begin',task:'Outline the next questions',detail:'Bring the team’s observations together before deciding what to build.'}
};
document.querySelectorAll('[data-mode]').forEach(button=>{
 button.addEventListener('click',()=>{
  const example=examples[button.dataset.mode];
  document.querySelectorAll('[data-mode]').forEach(other=>other.setAttribute('aria-pressed',String(other===button)));
  for(const [id,key] of [['sample-message','message'],['sample-attachment','attachment'],['board-type','type'],['board-note','note'],['agent-title','task'],['agent-detail','detail']])document.getElementById(id).textContent=example[key];
  document.getElementById('demo-help').textContent=`${button.textContent} example selected. This illustration does not capture media or run an agent.`;
 });
});
const brief=document.getElementById('brief-dialog');
document.getElementById('open-brief').addEventListener('click',()=>brief.showModal());
document.getElementById('close-brief').addEventListener('click',()=>brief.close());
