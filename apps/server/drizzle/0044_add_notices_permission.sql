-- Notices (6 October 2026, docs/features/notices.md): the new right MANAGE_NOTICES (bit 20 = 1048576) goes to every role that may
-- delete other people's messages today (MANAGE_MESSAGES, bit 9 = 512). Owners and administrators have it anyway; the default
-- roles "Gast" and "Mitglied" do not get it.
UPDATE "roles" SET "permissions" = "permissions" | 1048576 WHERE ("permissions" & 512) <> 0;
