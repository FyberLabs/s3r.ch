import {isSeaPubkey} from './identity/forum-check';
/** Navigation selects an account; it never grants access or carries message text. */
export function contactHref(principal:string){return isSeaPubkey(principal)?'/contacts#to='+encodeURIComponent(principal):null;}
export function contactTarget(fragment:string){const value=new URLSearchParams(fragment.replace(/^#/, '')).get('to');return value&&isSeaPubkey(value)?value:'';}
