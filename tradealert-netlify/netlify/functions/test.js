// Quick test endpoint — open in browser to send test alarm to your phone
const admin = require("firebase-admin");

let ready = false;
function init() {
  if (ready) return;
  try {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(sa), projectId:"tradealert-2602c" });
  } catch(e) {}
  ready = true;
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  try {
    init();
    const db = admin.firestore();
    const users = await db.collection("users").limit(1).get();
    if (users.empty) return { statusCode:400, body:"No users found" };
    const token = users.docs[0].data().fcmToken;
    await admin.messaging().send({
      token,
      data: {
        type:"PRICE_ALERT", alertId:"test-001",
        pairSymbol:"BTC", pairName:"Bitcoin", pairEmoji:"₿",
        targetPrice:"50000", currentPrice:"50001",
        direction:"above", hitType:"Instant Hit",
        isAlarm:"true", isSoundEnabled:"true", isVibration:"true",
      },
      android: { priority:"high" },
    });
    return { statusCode:200, body: JSON.stringify({ ok:true, message:"Test alarm sent! Check your phone." }) };
  } catch(e) {
    return { statusCode:500, body: JSON.stringify({ error:e.message }) };
  }
};
