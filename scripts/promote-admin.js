require("dotenv").config();
const { MongoClient } = require("mongodb");
(async () => {
  const email = process.env.SUPER_ADMIN_EMAIL?.trim();
  if (!email || !process.env.MONGODB_URI)
    throw new Error(
      "Set SUPER_ADMIN_EMAIL and MONGODB_URI locally. Register that account in the app first.",
    );
  const client = new MongoClient(process.env.MONGODB_URI);
  try {
    await client.connect();
    const users = client
      .db(process.env.MONGODB_DB || "career_connect")
      .collection("users");
    const escapedEmail = email
      .split("")
      .map((char) =>
        ".*+?^${}()|[]".includes(char) || char.charCodeAt(0) === 92
          ? String.fromCharCode(92) + char
          : char,
      )
      .join("");
    const user = await users.findOne({
      email: { $regex: "^" + escapedEmail + "$", $options: "i" },
    });
    if (!user)
      throw new Error(
        "Register this email in the app before running this script.",
      );
    await users.updateOne(
      { uid: user.uid },
      { $set: { userType: "admin", updatedAt: new Date() } },
    );
    console.log("Admin role assigned. Sign out and sign in again.");
  } finally {
    await client.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
