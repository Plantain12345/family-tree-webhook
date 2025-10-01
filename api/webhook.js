// api/webhook.js
import {
  createTree,
  joinTreeByCode,
  listPersonsForTree,
  findInTreeByName,
  listPersonsByExactName,
  upsertPersonByName,
  addRelationship,
  addChildWithParents,
  editPerson,
  personSummary,
  leaveCurrentTree,
  savePending,
  popPending,
  getUserState,
  setLastPerson,
  setActiveTreeState,
} from "./_db.js";

import { parseOps } from "./_nlp.js";

const BASE_URL = "https://family-tree-webhook.vercel.app";
const VERIFY_TOKEN = "myfamilytree123";

function treeUrl(code) {
  return `${BASE_URL}/tree.html?code=${encodeURIComponent(code)}`;
}

function shareLinkText(tree) {
  if (!tree?.join_code) return null;
  const liveUrl = treeUrl(tree.join_code);
  return `Forward this link to your family so they can join:\n${liveUrl}`;
}

const PRONOUNS = new Set([
  "his",
  "her",
  "my",
  "our",
  "me",
  "i",
]);
const looksLikePronoun = (s) => PRONOUNS.has((s || "").trim().toLowerCase());

const PARENT_KEYWORD_PATTERN = "(?:mother|father|mom|mum|dad|parent|parents)";

const GENDER_SYNONYMS = new Map([
  ["m", "male"],
  ["male", "male"],
  ["man", "male"],
  ["boy", "male"],
  ["f", "female"],
  ["female", "female"],
  ["woman", "female"],
  ["girl", "female"],
  ["nonbinary", "nonbinary"],
  ["non-binary", "nonbinary"],
  ["non binary", "nonbinary"],
  return (
    `I know more than one person named ${name}. Please tell me which one you mean by adding a detail such as their birth year or a close relative.` +
    (bullets.length ? `\n${bullets.join("\n")}` : "")
  );
}

async function ensureNamesAreDistinct(tree, names, replies) {
  if (!tree) return false;
  for (const rawName of names) {
    if (!rawName || looksLikePronoun(rawName)) continue;
    const note = await describeAmbiguity(tree.id, rawName);
    if (note) {
      replies.push(appendFollowUp(`${note}\nI haven't made any changes yet.`));
      return false;
    }
  }
  return true;
}

function menuGuidanceText(id, tree) {
  switch (id) {
    case "MENU_START_TREE":
      return "To start a new family tree, tell me its name. For example, say \"Create a family tree called The Kintu Family\".";
    case "MENU_JOIN_TREE":
      return "To join an existing tree, send the six-letter join code. Try something like \"Join ABC123\".";
@@ -94,51 +92,50 @@ function menuGuidanceText(id, tree) {
      }
      return "You're not in a tree yet. You can start one or join with a code that someone shares with you.";
    case "MENU_ADD_PERSON":
      return "Tell me about the person you'd like to add. For example, say \"Add Alice born 1950\".";
    case "MENU_LINK_RELATIVES":
      return "Describe the relationship you want me to add, such as \"Link Maria is John's mother\" or \"Add his son Noah\".";
    case "MENU_EDIT_PERSON":
      return "Let me know what needs updating. You can say things like \"Rename Maria to Mary\" or \"Set John's birth year to 1980\".";
    case "MENU_LEAVE_TREE":
      if (tree) {
        return `If you'd like to leave “${tree.name}”, just say \"Leave tree\" and I'll take care of it.`;
      }
      return "You're not currently part of a family tree, so there's nothing to leave.";
    case "MENU_HELP":
      return helpText();
    default:
      return "You can always tell me what you need in plain English.";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    const {
      "hub.mode": mode,
      "hub.verify_token": token,
        replies.push(appendFollowUp(helpText()));
        continue;
      }

      if (op.op === "menu") {
        await sendMenu(from);
        replies.push(appendFollowUp("I've sent you the menu of quick options."));
        continue;
      }

      if (op.op === "new_tree") {
        if (!op.name) {
          replies.push(
            appendFollowUp(
              "I need a name for the new family tree. Try saying something like \"Create a tree called The Kintu Family\"."
            )
          );
          continue;
        }

        const trimmed = op.name.trim();
        const { tree: createdTree } = await createTree(trimmed, from);
        await setActiveTreeState(from, createdTree.id);
        await setLastPerson(from, createdTree.id, null, null);
        activeTree = createdTree;
@@ -214,51 +211,50 @@ export default async function handler(req, res) {
        replies.push(appendFollowUp(message));
        continue;
      }

      if (op.op === "view_person") {
        if (!activeTree) {
          replies.push(
            appendFollowUp(
              "You're not in a family tree yet, so I can't show any relatives."
            )
          );
          continue;
        }

        const ok = await ensureNamesAreDistinct(activeTree, [op.name], replies);
        if (!ok) continue;

        const target = await findInTreeByName(activeTree.id, op.name);
        if (!target) {
          replies.push(
            appendFollowUp(
              `I couldn't find anyone named ${op.name} in this tree.`
            )
          );
          continue;
          )
        );
        continue;
      }

      if (op.op === "add_person") {
        const name = (op.name || "").trim();
        if (!name) {
          replies.push(
            appendFollowUp(
              "Please tell me the person's name so I can add them."
            )
          );
          continue;
        }

        const existing = await findInTreeByName(activeTree.id, name);
        const person = await upsertPersonByName(
          activeTree.id,
          name,
          op.dob || null
        );

        let message;
        if (!existing) {
@@ -411,51 +407,50 @@ export default async function handler(req, res) {
          )
        );
        await setLastPerson(from, activeTree.id, person.id, person.primary_name);
        continue;
      }

      if (op.op === "rename") {
        const ok = await ensureNamesAreDistinct(activeTree, [op.from], replies);
        if (!ok) continue;

        const target =
          (await findInTreeByName(activeTree.id, op.from)) ||
          (await upsertPersonByName(activeTree.id, op.from));
        await savePending(from, activeTree.id, {
          type: "rename",
          personId: target.id,
          to: op.to,
        });
        replies.push(
          appendFollowUp(
            `You asked me to rename “${target.primary_name}” to “${op.to}”. Reply YES to confirm or NO to cancel. I haven't changed anything yet.`
          )
        );
        continue;
      }
          type: "interactive",
          interactive: {
            type: "list",
            header: { type: "text", text: "Family tree helper" },
            body: {
              text: "Choose a shortcut or just tell me what you need in plain English.",
            },
            footer: { text: "You can also type 'menu' any time." },
            action: {
              button: "Show options",
              sections: [
                {
                  title: "Common actions",
                  rows: [
                    {
                      id: "MENU_START_TREE",
                      title: "Start a tree",
                      description: "Create a brand new family tree",
                    },
                    {
                      id: "MENU_JOIN_TREE",
                      title: "Join a tree",
                      description: "Enter a six-letter join code",
                    },
                    {
                      id: "MENU_SHARE_TREE",
                      title: "Share my tree",
                      description: "Get a link you can forward to family",
                    },
                    {
                      id: "MENU_ADD_PERSON",
                      title: "Add a person",
                      description: "Add someone new to the tree",
                    },
                    {
                      id: "MENU_LINK_RELATIVES",
                      title: "Link relatives",
                      description: "Add parent, child, or marriage links",
                    },
                    {
                      id: "MENU_EDIT_PERSON",
                      title: "Edit someone's details",
                      description: "Update a name, birth year, or gender",
                    },
                    {
                      id: "MENU_LEAVE_TREE",
                      title: "Leave tree",
                      description: "Remove yourself from the current tree",
                    },
                    {
                      id: "MENU_HELP",
                      title: "Help",
                      description: "See examples of what you can ask",
                    },
                  ],
                },
              ],
            },
          },
        }),
      }
    );

    if (!resp.ok) {
      const errorText = await resp.text();
      console.error(
        `[${new Date().toISOString()}] Send menu error:`,
        resp.status,
        errorText
      );
    }
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Failed to send menu:`,
      error
    );
  }
}

function helpText() {
  return [
    "I understand plain English. You can say things like:",
    "• \"Start a new tree called Kintu Family\"",
    "• \"Join code ABC123\"",
    "• \"Add Alice born 1950\"",
    "• \"Add his son Zaake born 1983\"",
    "• \"Link Alice is Bob's mother\" or \"Link Alice married to Bob\"",
    "• \"Show Alice\" or \"Show the tree\"",
    "• \"Set Alice's birth year to 1950\" or \"Rename Alice to Aaliyah\"",
    "• \"Leave tree\"",
    "Type 'menu' any time for quick shortcuts.",
  ].join("\n");
}
