/* squorli-plugin
{
  "id": "hello",
  "name": { "en": "Hello", "de": "Hallo" },
  "description": {
    "en": "The smallest plugin: a slash command that greets, and a welcome for new members.",
    "de": "Das kleinste Plugin: ein Schrägstrich-Befehl, der grüßt, und ein Willkommen für neue Mitglieder."
  },
  "version": "1.0.0",
  "apiVersion": 1,
  "capabilities": ["members.read", "messages.write"],
  "settings": [
    {
      "key": "channel",
      "type": "channel",
      "label": { "en": "Channel for the welcome", "de": "Kanal für das Willkommen" },
      "help": { "en": "Left empty, new members are not greeted.", "de": "Bleibt das Feld leer, werden neue Mitglieder nicht begrüßt." }
    },
    {
      "key": "greeting",
      "type": "text",
      "default": "Welcome",
      "maxLength": 80,
      "label": { "en": "Greeting", "de": "Gruß" }
    }
  ],
  "commands": [
    { "name": "hello", "description": { "en": "Says hello to you", "de": "Sagt dir Hallo" } },
    {
      "name": "say",
      "input": "text",
      "permission": "MANAGE_MESSAGES",
      "description": { "en": "Writes your text as the plugin", "de": "Schreibt deinen Text als Plugin" },
      "textHint": { "en": "text", "de": "Text" }
    }
  ]
}
*/

// The smallest useful plugin, in plain JavaScript. The guide walks through it line by line:
// https://squorli.com/en/docs/plugins/

// A member typed /hello or /say. Whatever a command handler returns is shown to that member only.
squorli.on("command", async (e) => {
  if (e.command === "hello") {
    const me = await squorli.members.get(e.by);
    return { message: { en: `Hello, ${me.displayName}!`, de: `Hallo, ${me.displayName}!` } };
  }
  if (e.command === "say") {
    if (!e.text) return { ok: false, message: { en: "Write the text after the command.", de: "Schreibe den Text hinter den Befehl." } };
    // A message everybody in the channel sees. During a command the plugin may write into the channel it was run in.
    await squorli.messages.send(e.channelId, e.text);
  }
});

// Somebody joined the server: greet them in the channel an admin picked in the settings.
squorli.on("member.join", async (e) => {
  const settings = await squorli.settings.get();
  if (!settings.channel) return;
  const member = await squorli.members.get(e.userId);
  if (member) await squorli.messages.send(settings.channel, `${settings.greeting}, ${member.displayName}!`);
});
