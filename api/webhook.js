export default async function handler(req, res) {
  // GET: verification
  if (req.method === "GET") {
    const VERIFY_TOKEN = "myfamilytree123";
    const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  // POST: messages
  if (req.method === "POST") {
    const body = req.body || {};
    const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0] ?? null;
    if (msg) {
      console.log("From:", msg.from);
      console.log("Text:", msg.text?.body);
    }
    return res.status(200).send("ok");
  }

  res.status(404).send("Not found");
}
