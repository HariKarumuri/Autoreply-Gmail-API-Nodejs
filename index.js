const fs = require("fs").promises;
const path = require("path");
const process = require("process");
const { authenticate } = require("@google-cloud/local-auth");
const { google } = require("googleapis");

// If modifying these scopes, delete token.json.
const SCOPES = ["https://mail.google.com/"];
// The file token.json stores the user's access and refresh tokens and is
// created automatically when the authorization flow completes for the first
// time.
const TOKEN_PATH = path.join(process.cwd(), "token.json");
const CREDENTIALS_PATH = path.join(process.cwd(), "credentials.json");

// Label name for marking replied emails
const AUTOREPLIED_LABEL = "AUTOREPLIED";


async function loadSavedCredentialsIfExist() {
  try {
    const content = await fs.readFile(TOKEN_PATH);
    const credentials = JSON.parse(content);
    return google.auth.fromJSON(credentials);
  } catch (err) {
    return null;
  }
}


async function saveCredentials(client) {
  const content = await fs.readFile(CREDENTIALS_PATH);
  const keys = JSON.parse(content);
  const key = keys.installed || keys.web;
  const payload = JSON.stringify({
    type: "authorized_user",
    client_id: key.client_id,
    client_secret: key.client_secret,
    refresh_token: client.credentials.refresh_token,
  });
  await fs.writeFile(TOKEN_PATH, payload);
}


async function authorize() {
  let client = await loadSavedCredentialsIfExist();
  if (client) {
    return client;
  }
  client = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH,
  });
  if (client.credentials) {
    await saveCredentials(client);
  }
  return client;
}


async function fetchUnreadEmails(auth) {
  const gmail = google.gmail({ version: "v1", auth });
  const res = await gmail.users.messages.list({
    userId: "me",
    labelIds: ["INBOX", "UNREAD"],
  });

  const messages = res.data.messages;
  if (!messages || messages.length === 0) {
    console.log("No unread emails found.");
    return [];
  }

  // Exclude promotional and social emails because unread is getting bigger 
  const filteredMessages = messages.filter((message) => {
    const labels = message.labelIds || [];
    return (
      !labels.includes("CATEGORY_PROMOTIONS") &&
      !labels.includes("CATEGORY_SOCIAL")
    );
  });

  return filteredMessages;
}


async function hasReplied(auth, threadId) {
  try {
    const gmail = google.gmail({ version: "v1", auth });
    const autorepliedLabelId = await addLabel(auth, AUTOREPLIED_LABEL);

    if (!autorepliedLabelId) {
      console.error("Failed to obtain label ID. Exiting.");
      return false;
    }

    const res = await gmail.users.messages.get({
      userId: "me",
      id: threadId,
    });
    const labels = res.data.labelIds || [];
    return labels.includes(autorepliedLabelId);
  } catch (err) {
    console.error("Error checking if replied:", err.message);
    return false;
  }
}


async function addLabel(auth, labelName) {
  const gmail = google.gmail({ version: "v1", auth });
  const user = "me";

  // Check if the label exists
  const labelsResponse = await gmail.users.labels.list({ userId: user });
  const labels = labelsResponse.data.labels;
  const label = labels.find((l) => l.name === labelName);

  if (!label) {
    // If the label doesn't exist, create it
    const createdLabel = await gmail.users.labels.create({
      userId: user,
      requestBody: {
        name: labelName,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      },
    });
    return createdLabel.data.id;
  }

  // If the label exists, return its ID
  return label.id;
}


async function markAsReplied(auth, threadId) {
  try {
    const gmail = google.gmail({ version: "v1", auth });

    // Get the label ID for AUTOREPLIED_LABEL
    const autorepliedLabelId = await addLabel(auth, AUTOREPLIED_LABEL);

    if (!autorepliedLabelId) {
      console.error("Failed to obtain label ID. Exiting.");
      return;
    }

    // Add AUTOREPLIED label to the email and remove INBOX
    await gmail.users.messages.modify({
      userId: "me",
      id: threadId,
      requestBody: {
        addLabelIds: [autorepliedLabelId],
        removeLabelIds: ["INBOX"],
      },
    });
  } catch (err) {
    console.error("Error marking as replied:", err.message);
  }
}


async function sendAutoReply(auth, threadId) {
  const gmail = google.gmail({ version: "v1", auth });

  try {
    const res = await gmail.users.messages.get({
      userId: "me",
      id: threadId,
    });

    const message = res.data;
    const senderEmail = message.payload.headers.find(
      (header) => header.name === "From"
    ).value;

    // Check if you've already replied to this thread
    const hasRepliedToThread = await hasReplied(auth, threadId);
    if (hasRepliedToThread) {
      console.log(`Already replied to the email from ${senderEmail}. Skipping.`);
      return;
    }

    
    const recipientEmail = senderEmail;

    // Send auto-reply with recipient's email address
    const autoReply =
      "Thank you for your email. I am excited to look forward to it!";
    const reply = `To: ${recipientEmail}\r\nFrom: ${senderEmail}\r\n\r\n${autoReply}`;
    await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw: Buffer.from(reply).toString("base64"),
        threadId,
      },
    });

    // Mark the thread as replied
    await markAsReplied(auth, threadId);

    console.log(`Auto-reply sent to ${senderEmail}.`);
  } catch (err) {
    console.error("Error sending auto-reply:", err.message);
  }
}

/**
 * Main function to execute the sequence of steps.
 */
async function main() {
  const auth = await authorize();

  while (true) {
    try {
      // Fetch unread emails
      const unreadEmails = await fetchUnreadEmails(auth);

      // Process each unread email
      for (const email of unreadEmails) {
        // Send auto-reply if not already replied
        await sendAutoReply(auth, email.id);
      }

      // Wait for a random interval between 45 to 120 seconds
      const randomInterval = Math.floor(Math.random() * (120 - 45 + 1)) + 45;
      console.log(`Waiting for ${randomInterval} seconds...`);
      await sleep(randomInterval * 1000); // Convert seconds to milliseconds
    } catch (err) {
      console.error("Error in main loop:", err.message);
    }
  }
}

/**
 * Function to sleep for a given duration in milliseconds.
 *
 * @param {number} ms Duration in milliseconds.
 * @return {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);
