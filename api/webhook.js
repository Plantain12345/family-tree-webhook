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
@@ -37,294 +37,764 @@ const PRONOUNS = new Set([
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
@@ -163,53 +169,57 @@ async function describeAmbiguity(treeId, name) {
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
    case "MENU_SHOW_CODE":
    case "MENU_SHARE_TREE":
      if (tree) {
        return `Your current tree is “${tree.name}”. Share the join code ${tree.join_code} so others can join.`;
        const shareMessage = shareLinkText(tree);
        if (shareMessage) {
          return `${shareMessage}\nYou can open it yourself or forward it to relatives.`;
        }
        return "I couldn't find a shareable link just now. Please try again in a moment.";
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
@@ -330,120 +340,119 @@ export default async function handler(req, res) {
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
        const liveUrl = treeUrl(createdTree.join_code);
        const message =
          `I created a new family tree called “${createdTree.name}” and made it your active tree. Share the join code ${createdTree.join_code} or visit ${liveUrl} to view it.`;
        const shareMessage = shareLinkText(createdTree);
        const message = shareMessage
          ? `I created a new family tree called “${createdTree.name}” and made it your active tree.\n${shareMessage}`
          : `I created a new family tree called “${createdTree.name}” and made it your active tree.`;
        replies.push(appendFollowUp(message));
        continue;
      }

      if (op.op === "join_tree") {
        if (!op.code) {
          replies.push(
            appendFollowUp(
              "Please tell me the six-letter code you'd like to join, for example \"Join ABC123\"."
            )
          );
          continue;
        }

        const joinResult = await joinTreeByCode(op.code.toUpperCase(), from);
        if (!joinResult.tree) {
          replies.push(
            appendFollowUp(
              `I couldn't find a tree with the code ${op.code.toUpperCase()}, so nothing changed.`
            )
          );
          continue;
        }

        activeTree = joinResult.tree;
        await setActiveTreeState(from, activeTree.id);
        await setLastPerson(from, activeTree.id, null, null);
        const liveUrl = treeUrl(activeTree.join_code);
        const message =
          `I added you to “${activeTree.name}” and made it your active tree. Share the join code ${activeTree.join_code} or visit ${liveUrl} to see it.`;
          `You're now part of “${activeTree.name}”, and it's set as your active tree. Choose "Share my tree" from the menu when you'd like to send the link to someone.`;
        replies.push(appendFollowUp(message));
        continue;
      }

      if (op.op === "leave") {
        const result = await leaveCurrentTree(from);
        if (!result.left) {
          replies.push(
            appendFollowUp(
              "You're not currently in a family tree, so there's nothing for me to leave."
            )
          );
          continue;
        }
        await setActiveTreeState(from, null);
        await setLastPerson(from, null, null, null);
        activeTree = null;
        replies.push(
          appendFollowUp(
            `I removed you from “${result.tree.name}”.`
          )
        );
        continue;
      }

      if (op.op === "view_tree") {
        if (!activeTree) {
          replies.push(
            appendFollowUp(
              "You're not in a family tree yet. You can start one or join with a code from a relative."
            )
          );
          continue;
        }
        const liveUrl = treeUrl(activeTree.join_code);
        const message =
          `I didn't change anything; here's the information you asked for. “${activeTree.name}” uses join code ${activeTree.join_code} and you can view it at ${liveUrl}.`;
          `I didn't change anything; “${activeTree.name}” is still your active tree. Use the "Share my tree" option in the menu whenever you want the link again.`;
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
@@ -471,196 +480,196 @@ export default async function handler(req, res) {
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
          message = `I added ${person.primary_name}${
            op.dob ? `, born ${op.dob}` : ""
          } to your tree.`;
          const birthDetail = op.dob ? ` (b. ${op.dob})` : "";
          message = `You've added ${person.primary_name}${birthDetail}.`;
        } else if (op.dob && op.dob !== (existing.dob_dmy || "")) {
          message = `I updated ${person.primary_name}'s birth information to ${op.dob}.`;
          message = `${person.primary_name}'s birth information is now ${op.dob}.`;
        } else {
          message = `I found ${person.primary_name} already in your tree, so nothing needed to change.`;
          message = `${person.primary_name} was already in the tree, so nothing changed.`;
        }

        replies.push(appendFollowUp(message));
        await setLastPerson(from, activeTree.id, person.id, person.primary_name);
        continue;
      }

      if (op.op === "link") {
        const ok = await ensureNamesAreDistinct(
          activeTree,
          [op.a, op.b],
          replies
        );
        if (!ok) continue;

        const A = await upsertPersonByName(activeTree.id, op.a);
        const B = await upsertPersonByName(activeTree.id, op.b);

        const msgLower = text.toLowerCase();
        let kind = (op.kind || "").toLowerCase();
        if (!["spouse_of", "partner_of", "parent_of"].includes(kind)) {
          if (/(married|wife|husband|spouse|wed|weds)/.test(msgLower)) {
            kind = "spouse_of";
          } else if (/partner/.test(msgLower)) {
            kind = "partner_of";
          } else if (/(father|mother|parent|son|daughter|child)/.test(msgLower)) {
            kind = "parent_of";
          } else {
            kind = "spouse_of";
          }
        }

        if (kind === "parent_of") {
          const hint = guessParentDirection(text, A.primary_name, B.primary_name);
          let parentPerson = A;
          let childPerson = B;
          if (hint?.parent === "b") {
            parentPerson = B;
            childPerson = A;
          }
          await addRelationship(
            activeTree.id,
            parentPerson.id,
            "parent_of",
            childPerson.id
          );
          replies.push(
            appendFollowUp(
              `I linked ${parentPerson.primary_name} as ${childPerson.primary_name}'s parent.`
              `${parentPerson.primary_name} is now listed as ${childPerson.primary_name}'s parent.`
            )
          );
          await setLastPerson(
            from,
            activeTree.id,
            childPerson.id,
            childPerson.primary_name
          );
          continue;
        }

        await addRelationship(activeTree.id, A.id, kind, B.id);
        const pretty = kind === "partner_of" ? "partners" : "spouses";
        replies.push(
          appendFollowUp(
            `I linked ${A.primary_name} and ${B.primary_name} as ${pretty}.`
            `${A.primary_name} and ${B.primary_name} have been linked as ${pretty}.`
          )
        );
        await setLastPerson(from, activeTree.id, B.id, B.primary_name);
        continue;
      }

      if (op.op === "add_child") {
        const ok = await ensureNamesAreDistinct(
          activeTree,
          [op.parentA, op.parentB].filter(Boolean),
          replies
        );
        if (!ok) continue;

        const child = await addChildWithParents(
          activeTree.id,
          op.child,
          op.dob || null,
          op.parentA,
          op.parentB || null
        );

        const parents = [op.parentA, op.parentB].filter(Boolean).join(" and ");
        const message = `I added ${child.primary_name}${
          op.dob ? `, born ${op.dob}` : ""
        const childBirthDetail = op.dob ? ` (b. ${op.dob})` : "";
        const message = `You've added ${child.primary_name}${
          childBirthDetail
        } as the child of ${parents}.`;
        replies.push(appendFollowUp(message));
        await setLastPerson(
          from,
          activeTree.id,
          child.id,
          child.primary_name
        );
        continue;
      }

      if (op.op === "set_dob") {
        const ok = await ensureNamesAreDistinct(activeTree, [op.name], replies);
        if (!ok) continue;

        const person = await upsertPersonByName(
          activeTree.id,
          op.name,
          op.dob || null
        );
        const message = op.dob
          ? `I updated ${person.primary_name}'s birth information to ${op.dob}.`
          : `I cleared ${person.primary_name}'s birth information.`;
          ? `${person.primary_name}'s birth information is now ${op.dob}.`
          : `Birth information for ${person.primary_name} has been cleared.`;
        replies.push(appendFollowUp(message));
        await setLastPerson(from, activeTree.id, person.id, person.primary_name);
        continue;
      }

      if (op.op === "set_gender") {
        const ok = await ensureNamesAreDistinct(activeTree, [op.name], replies);
        if (!ok) continue;

        const normalized = normalizeGenderValue(op.gender);
        if (!normalized) {
          replies.push(
            appendFollowUp(
              `I couldn't understand the gender you provided for ${op.name}, so I didn't change anything.`
            )
          );
          continue;
        }

        const person = await upsertPersonByName(activeTree.id, op.name);
        await editPerson(activeTree.id, person.id, { gender: normalized });
        const prettyGender =
          normalized.charAt(0).toUpperCase() + normalized.slice(1);
        replies.push(
          appendFollowUp(
            `I recorded ${person.primary_name}'s gender as ${prettyGender}.`
            `${person.primary_name}'s gender is now ${prettyGender}.`
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
@@ -822,53 +831,53 @@ async function sendMenu(to) {
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
                      id: "MENU_SHOW_CODE",
                      title: "Show my tree code",
                      description: "Share the code for your current tree",
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
