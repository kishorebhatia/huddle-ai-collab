'use strict';
const slides=[...document.querySelectorAll('.slide')];
const previous=document.querySelector('.previous');
const next=document.querySelector('.next');
let current=0;
function showSlide(index){
 current=Math.max(0,Math.min(slides.length-1,index));
 slides.forEach((slide,i)=>{slide.hidden=i!==current;slide.classList.toggle('active',i===current);});
 previous.hidden=current===0||current===slides.length-1;
 next.hidden=current===slides.length-1;
}
previous.addEventListener('click',()=>showSlide(current-1));
next.addEventListener('click',()=>showSlide(current+1));
document.querySelector('main').addEventListener('click',()=>showSlide(current+1));
document.addEventListener('keydown',event=>{
 if(event.altKey||event.ctrlKey||event.metaKey)return;
 if(['ArrowRight','ArrowDown','PageDown',' '].includes(event.key)){event.preventDefault();showSlide(current+1);}
 if(['ArrowLeft','ArrowUp','PageUp'].includes(event.key)){event.preventDefault();showSlide(current-1);}
 if(event.key==='Home'){event.preventDefault();showSlide(0);}
 if(event.key==='End'){event.preventDefault();showSlide(slides.length-1);}
});
showSlide(0);
