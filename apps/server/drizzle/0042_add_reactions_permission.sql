-- Reactions (6 October 2026, docs/features/reactions.md; the user's decision of the same day): the new right ADD_REACTIONS
-- (bit 19 = 524288) goes to every role that may write today (SEND_MESSAGES, bit 8 = 256): "Mitglied" yes, "Gast" no.
-- Owners and administrators have it anyway. A guest still accepts the rules: an emoji configured as a reaction role needs no right.
UPDATE "roles" SET "permissions" = "permissions" | 524288 WHERE ("permissions" & 256) <> 0;
