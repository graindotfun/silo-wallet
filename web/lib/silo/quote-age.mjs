/** Quote age is presentation; signing still independently revalidates the exact review. */
export function siloQuoteAge(review,now=Date.now()){
 if(!review||!Number.isSafeInteger(now)||!Number.isSafeInteger(review.checkedAt)||!Number.isSafeInteger(review.expiresAt)||review.checkedAt<0||review.expiresAt<=review.checkedAt||review.expiresAt-review.checkedAt>30000||now<review.checkedAt)return {state:'unknown',canApprove:false,ageSeconds:null,remainingSeconds:null};
 const expired=now>=review.expiresAt;return {state:expired?'expired':'fresh',canApprove:!expired,ageSeconds:Math.floor((now-review.checkedAt)/1000),remainingSeconds:Math.max(0,Math.ceil((review.expiresAt-now)/1000))};
}
