// Emoji picker data: common emojis by category, each with words to search by. Emojis are plain text, so WhatsApp
// delivers them as typed.

export type Emoji = { e: string; n: string };
export type EmojiGroup = { key: string; label: string; icon: string; emojis: Emoji[] };

const g = (key: string, label: string, icon: string, list: string): EmojiGroup => ({
  key,
  label,
  icon,
  emojis: list
    .trim()
    .split('\n')
    .map((line) => {
      const [e, ...n] = line.trim().split(' ');
      return { e, n: n.join(' ') };
    }),
});

export const EMOJI_GROUPS: EmojiGroup[] = [
  g('smileys', 'Smileys', '😀', `
😀 grinning smile happy
😃 smiley happy
😄 smile happy laugh
😁 grin beaming
😆 laughing
😅 sweat smile relief
😂 joy tears laugh
🤣 rofl rolling laugh
🙂 slightly smiling
😊 blush smiling happy
😇 innocent halo
😉 wink
😍 heart eyes love
🥰 smiling hearts love
😘 kiss
😋 yum tasty
😎 cool sunglasses
🤩 star struck wow
🥳 party celebrate
😏 smirk
😌 relieved
🤔 thinking hmm
🤗 hug
🤝 handshake deal
😐 neutral
😑 expressionless
😶 no mouth speechless
🙄 eye roll
😬 grimace awkward
😴 sleeping
😪 sleepy
😷 mask sick
🤒 sick fever
🤧 sneeze
😵 dizzy
🤯 mind blown
😕 confused
😟 worried
🙁 frown
😮 surprised wow
😲 astonished
😳 flushed
🥺 pleading please
😢 cry sad
😭 sob crying
😤 triumph huff
😠 angry
😡 rage angry
🤬 cursing
😱 scream shock
😨 fearful
🙏 pray please thanks
🫡 salute
`),
  g('gestures', 'Gestures', '👍', `
👍 thumbs up ok yes like
👎 thumbs down no dislike
👌 ok perfect
✌️ victory peace
🤞 fingers crossed luck
🤙 call me
👋 wave hello bye hi
🙌 raised hands celebrate
👏 clap applause
💪 strong muscle
✋ raised hand stop
👉 point right
👈 point left
👆 point up
👇 point down
☝️ index up
✍️ writing
🤲 palms up
🫶 heart hands love
`),
  g('hearts', 'Hearts', '❤️', `
❤️ red heart love
🧡 orange heart
💛 yellow heart
💚 green heart
💙 blue heart
💜 purple heart
🖤 black heart
🤍 white heart
💔 broken heart
💕 two hearts
💖 sparkling heart
💯 hundred perfect
✨ sparkles
⭐ star
🌟 glowing star
🔥 fire hot
🎉 party tada celebrate
🎊 confetti
🎁 gift present
🏆 trophy winner
`),
  g('auto', 'Car & tyres', '🚗', `
🚗 car automobile
🚙 suv car
🚕 taxi
🛻 pickup truck
🚚 delivery truck
🚛 lorry truck
🏎️ racing car
🏍️ motorcycle bike
🛞 wheel tyre tire
🔧 wrench repair fix
🔩 bolt nut
🛠️ tools repair
⚙️ gear settings
⛽ fuel petrol gas
🛣️ road highway
🚦 traffic light
🅿️ parking
🧰 toolbox
🪛 screwdriver
🚘 oncoming car
`),
  g('objects', 'Business', '💼', `
💼 briefcase work
📦 package parcel delivery
🚚 delivery shipping
🧾 receipt invoice bill
💳 card payment
💰 money bag
💵 cash dollar
📍 location pin
🗺️ map
📅 calendar date
🕐 clock time
⏰ alarm reminder
📞 phone call
📱 mobile
💬 chat message
📧 email
📝 note memo
📌 pushpin
🔗 link
📷 camera photo
🛒 cart shopping
🏷️ label tag price
🏪 store shop
🏢 office building
`),
  g('symbols', 'Symbols', '✅', `
✅ check done yes
✔️ check mark
❌ cross no wrong
❗ exclamation important
❓ question
⚠️ warning
🚫 prohibited no
⏳ hourglass wait
🔄 repeat refresh
➡️ right arrow
⬅️ left arrow
⬆️ up arrow
⬇️ down arrow
🆕 new
🆗 ok
🆓 free
🔴 red circle
🟢 green circle
🟡 yellow circle
🔵 blue circle
`),
];

// Search all groups by name (every word must match the start of a word in the name); empty = nothing
export function searchEmojis(query: string, groups = EMOJI_GROUPS) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const seen = new Set<string>();
  const out: Emoji[] = [];
  for (const grp of groups)
    for (const em of grp.emojis) {
      const names = em.n.toLowerCase().split(' ');
      if (!seen.has(em.e) && words.every((w) => names.some((n) => n.startsWith(w)))) {
        seen.add(em.e);
        out.push(em);
      }
    }
  return out;
}

// Puts text at the cursor (replacing any selection) and says where the cursor goes next
export function insertAt(text: string, insert: string, start: number, end = start) {
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(s, Math.min(end, text.length));
  return { text: text.slice(0, s) + insert + text.slice(e), cursor: s + insert.length };
}

// Recently used, newest first, at most `max` (kept in this browser)
export function pushRecent(recent: string[], emoji: string, max = 16) {
  return [emoji, ...recent.filter((e) => e !== emoji)].slice(0, max);
}
