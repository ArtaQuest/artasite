/**
 * The emoji set the composer picks from — data only, no dependency.
 *
 * WHY A HAND-KEPT LIST and not a full Unicode table: the complete set is ~3,800 emoji and every
 * usable one needs search keywords, which is a 300–600 KB dataset. That is more bytes than the
 * whole Messages chunk, downloaded by everyone, to reach glyphs almost nobody types. This is the
 * set people actually send, with the keywords they actually search — and the composer accepts any
 * emoji from the system keyboard regardless, so nothing here is a ceiling on what can be sent.
 *
 * Format is `glyph keyword keyword …` in one string per group, split at load: it keeps the source
 * legible and the parsed shape identical to what search wants.
 */

export type EmojiGroup = { key: string; label: string; icon: string; items: Emoji[] };
export type Emoji = { c: string; k: string };

/** `c` is the character; `k` is its space-joined keywords (already lower-case). */
function parse(spec: string): Emoji[] {
  return spec
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const sp = line.indexOf(" ");
      return sp < 0 ? { c: line, k: "" } : { c: line.slice(0, sp), k: line.slice(sp + 1).toLowerCase() };
    });
}

export const EMOJI_GROUPS: EmojiGroup[] = [
  {
    key: "smileys", label: "Smileys", icon: "🙂",
    items: parse(`
😀 grin happy smile
😃 smile happy joy
😄 happy laugh joy
😁 beam grin happy
😆 laugh haha squint
😅 sweat laugh relief
🤣 rofl rolling laugh
😂 joy tears laugh crying
🙂 slight smile
🙃 upside down silly
😉 wink
😊 blush smile happy
😇 halo angel innocent
🥰 love hearts adore
😍 heart eyes love
🤩 star struck wow
😘 kiss blow
😗 kiss
😚 kiss closed
🥲 tear smile happy sad
😋 yum tongue tasty
😛 tongue cheeky
😜 wink tongue joke
🤪 zany crazy silly
😝 tongue squint
🤑 money rich
🤗 hug hands
🤭 oops giggle hand
🤫 shush quiet secret
🤔 think hmm ponder
🤐 zipper quiet secret
🤨 raised eyebrow doubt
😐 neutral meh
😑 expressionless blank
😶 no mouth speechless
😏 smirk sly
😒 unamused meh annoyed
🙄 eye roll
😬 grimace awkward
🤥 lying pinocchio
😌 relieved calm
😔 sad pensive
😪 sleepy tired
🤤 drool
😴 sleep zzz tired
😷 mask sick
🤒 sick thermometer ill
🤕 hurt bandage injured
🤢 sick nausea gross
🤮 vomit sick
🤧 sneeze tissue
🥵 hot heat sweat
🥶 cold freeze
😵 dizzy knocked out
🤯 mind blown explode
🤠 cowboy
🥳 party celebrate birthday
😎 cool sunglasses
🤓 nerd glasses geek
🧐 monocle inspect
😕 confused
😟 worried
🙁 frown sad
😮 open mouth surprise wow
😯 hushed surprise
😲 astonished shock
😳 flushed embarrassed
🥺 pleading puppy beg
😦 frown open
😧 anguished
😨 fearful scared
😰 anxious sweat
😥 sad relieved
😢 cry sad tear
😭 sob cry loud
😱 scream fear shock
😖 confounded
😣 persevere struggle
😞 disappointed sad
😓 sweat sad
😩 weary tired
😫 tired exhausted
🥱 yawn bored
😤 triumph steam angry
😡 rage angry mad
😠 angry mad
🤬 swearing cursing angry
😈 devil mischief
👿 imp angry devil
💀 skull dead
☠️ skull crossbones danger
💩 poop
🤡 clown
👻 ghost boo
👽 alien
🤖 robot bot
`),
  },
  {
    key: "gestures", label: "People", icon: "👍",
    items: parse(`
👋 wave hello hi bye
🤚 hand raised
✋ hand stop high five
🖐️ hand fingers
🖖 vulcan spock
👌 ok perfect
🤌 pinched italian
🤏 pinch small
✌️ peace victory
🤞 crossed fingers luck
🤟 love you
🤘 rock horns
🤙 call me shaka
👈 point left
👉 point right
👆 point up
👇 point down
☝️ point up index
👍 thumbs up like yes good
👎 thumbs down dislike no
✊ fist raised
👊 fist bump punch
🤛 fist left
🤜 fist right
👏 clap applause bravo
🙌 raise hands praise celebrate
👐 open hands hug
🤲 palms up
🤝 handshake deal agree
🙏 pray thanks please namaste
✍️ writing hand
💅 nails polish
💪 muscle strong flex
🦾 mechanical arm
🧠 brain mind
👀 eyes look see
👁️ eye
👄 mouth lips
🫶 heart hands love
👶 baby
🧑 person
👩 woman
👨 man
🧓 older person
👮 police officer
🕵️ detective spy
👷 construction worker
🧑‍🍳 cook chef
🧑‍🎓 student graduate
🧑‍🏫 teacher
🧑‍💻 developer coder programmer
🧑‍🔬 scientist researcher
🧑‍🚀 astronaut space
🧑‍🎨 artist painter
🦸 superhero
🧙 mage wizard
🧚 fairy
🧑‍🤝‍🧑 people holding hands friends
💃 dance dancer
🕺 dance man
🚶 walk
🏃 run running
🧘 yoga meditate calm
`),
  },
  {
    key: "nature", label: "Nature", icon: "🌓",
    items: parse(`
🐶 dog puppy
🐱 cat kitten
🐭 mouse
🐹 hamster
🐰 rabbit bunny
🦊 fox
🐻 bear
🐼 panda
🐨 koala
🐯 tiger
🦁 lion
🐮 cow
🐷 pig
🐸 frog
🐵 monkey
🐔 chicken
🐧 penguin
🐦 bird
🦆 duck
🦅 eagle
🦉 owl
🦇 bat
🐺 wolf
🐗 boar
🐴 horse
🦄 unicorn
🐝 bee
🐛 caterpillar bug
🦋 butterfly
🐌 snail slow
🐞 ladybug
🐜 ant
🕷️ spider
🐢 turtle
🐍 snake
🦎 lizard
🐙 octopus
🦑 squid
🦐 shrimp
🐟 fish
🐬 dolphin
🐳 whale
🦈 shark
🐊 crocodile
🐘 elephant
🦏 rhino
🐪 camel
🦒 giraffe
🐄 cow
🐑 sheep
🌵 cactus
🎄 christmas tree
🌲 evergreen tree
🌳 tree
🌴 palm tree
🌱 seedling sprout grow
🌿 herb leaf
☘️ shamrock clover
🍀 four leaf clover luck
🍂 fallen leaves autumn
🍁 maple leaf
🍄 mushroom
🌾 wheat grain
💐 bouquet flowers
🌹 rose flower
🌺 hibiscus flower
🌻 sunflower
🌷 tulip
🌸 blossom cherry sakura
🌼 daisy flower
🌞 sun face
🌝 full moon face
🌓 first quarter moon
🌙 crescent moon night
⭐ star
🌟 glowing star sparkle
✨ sparkles magic
⚡ lightning bolt fast energy
🔥 fire lit hot
🌈 rainbow
☀️ sun sunny
⛅ partly cloudy
☁️ cloud
🌧️ rain
⛈️ storm thunder
❄️ snowflake cold
💧 droplet water
🌊 wave ocean sea
🌍 earth globe world
🌌 milky way galaxy space
`),
  },
  {
    key: "food", label: "Food", icon: "🍕",
    items: parse(`
🍏 green apple
🍎 apple
🍐 pear
🍊 orange tangerine
🍋 lemon
🍌 banana
🍉 watermelon
🍇 grapes
🍓 strawberry
🫐 blueberries
🍈 melon
🍒 cherries
🍑 peach
🥭 mango
🍍 pineapple
🥥 coconut
🥝 kiwi
🍅 tomato
🥑 avocado
🥦 broccoli
🥕 carrot
🌽 corn
🌶️ chilli pepper spicy
🥔 potato
🍞 bread
🥐 croissant
🥖 baguette
🧀 cheese
🥚 egg
🍳 cooking fried egg
🥞 pancakes
🧇 waffle
🥓 bacon
🍔 burger hamburger
🍟 fries chips
🍕 pizza
🌭 hot dog
🥪 sandwich
🌮 taco
🌯 burrito
🥙 wrap
🧆 falafel
🥗 salad
🍝 pasta spaghetti
🍜 ramen noodles
🍲 stew pot
🍛 curry rice
🍣 sushi
🍤 tempura shrimp
🍚 rice
🍙 rice ball
🥟 dumpling
🍦 ice cream soft serve
🍩 doughnut
🍪 cookie biscuit
🎂 birthday cake
🍰 cake slice
🧁 cupcake
🥧 pie
🍫 chocolate
🍬 sweet candy
🍭 lollipop
🍯 honey
🍼 baby bottle milk
🥛 milk glass
☕ coffee tea hot
🫖 teapot tea
🍵 green tea matcha
🧃 juice box
🥤 soft drink cup
🧋 bubble tea boba
🍺 beer
🍻 cheers beers
🥂 clink champagne celebrate
🍷 wine
🥃 whisky tumbler
🍸 cocktail martini
🧉 mate
🧊 ice cube
`),
  },
  {
    key: "activity", label: "Activity", icon: "⚽",
    items: parse(`
⚽ football soccer
🏀 basketball
🏈 american football
⚾ baseball
🎾 tennis
🏐 volleyball
🏉 rugby
🥏 frisbee
🎱 pool 8 ball
🏓 table tennis ping pong
🏸 badminton
🥅 goal net
🏒 hockey
🏑 field hockey
🥍 lacrosse
🏏 cricket
⛳ golf
🏹 archery bow
🎣 fishing
🥊 boxing
🥋 martial arts
🎽 running shirt
⛸️ ice skate
🥌 curling
🎿 ski
⛷️ skier
🏂 snowboard
🏋️ weightlifting gym
🤸 cartwheel gymnastics
🤾 handball
🏌️ golfer
🏇 horse racing
🧗 climbing
🚴 cycling bike
🏊 swimming
🤽 water polo
🚣 rowing
🏆 trophy win champion
🥇 gold medal first
🥈 silver medal second
🥉 bronze medal third
🏅 medal
🎖️ military medal
🎯 target bullseye direct hit
🎲 dice game
🎮 game controller gaming
🕹️ joystick arcade
🎰 slot machine
🧩 puzzle piece
♟️ chess pawn
🎨 art palette paint
🎭 theatre masks drama
🎤 microphone sing karaoke
🎧 headphones music listen
🎼 musical score
🎹 piano keyboard
🥁 drum
🎷 saxophone
🎺 trumpet
🎸 guitar
🎻 violin
🪕 banjo
🎬 clapper film movie
🎥 movie camera
📷 camera photo
📸 camera flash
`),
  },
  {
    key: "objects", label: "Objects", icon: "💡",
    items: parse(`
⌚ watch
📱 phone mobile
💻 laptop computer
⌨️ keyboard
🖥️ desktop computer
🖨️ printer
🖱️ mouse computer
💾 floppy disk save
💿 disc cd
📀 dvd
📼 videotape
📡 satellite antenna signal
🔋 battery
🔌 plug power
💡 bulb idea light
🔦 torch flashlight
🕯️ candle
🧯 fire extinguisher
🛢️ oil drum
💸 money wings spend
💵 dollar cash money
💴 yen
💶 euro
💷 pound
💰 money bag
💳 credit card
🧾 receipt
💎 gem diamond
⚖️ scales balance justice
🪜 ladder
🧰 toolbox
🔧 spanner wrench fix
🔨 hammer
⚒️ hammer pick tools
🛠️ tools
⛏️ pick mine
🔩 bolt nut
⚙️ gear cog settings
🧲 magnet
🔬 microscope science
🔭 telescope astronomy
📐 triangle ruler geometry
📏 ruler measure
🧮 abacus count
📌 pin
📍 round pin location
🖇️ paperclips
📎 paperclip attach
✂️ scissors cut
🗑️ bin trash delete
🔒 locked private
🔓 unlocked
🔐 locked key secure
🔑 key
🗝️ old key
🚪 door
🛋️ sofa couch
🛏️ bed sleep
🚿 shower
🛁 bath
🧼 soap wash
🧽 sponge
🔔 bell notification
🔕 bell off mute silent
📢 loudspeaker announce
📣 megaphone shout
📯 postal horn
🎉 party popper celebrate congrats
🎊 confetti ball celebrate
🎈 balloon
🎁 gift present
🎀 ribbon bow
🧧 red envelope
✉️ envelope email
📩 incoming envelope
📨 incoming mail
📤 outbox sent
📥 inbox received
📦 package box parcel
🏷️ label tag
📚 books library read
📖 open book read
📓 notebook
📔 notebook decorative
📒 ledger
📃 page curl document
📜 scroll
📄 page document
📰 newspaper news
📅 calendar date
📆 calendar tear off
🗓️ spiral calendar
📇 card index
📈 chart up trend growth
📉 chart down decline
📊 bar chart data
📋 clipboard
🗂️ card index dividers
🗄️ file cabinet
🕰️ mantel clock
⏰ alarm clock
⏳ hourglass time waiting
⌛ hourglass done
🧪 test tube experiment
🧫 petri dish
🧬 dna genetics
💊 pill medicine
🩺 stethoscope doctor
`),
  },
  {
    key: "symbols", label: "Symbols", icon: "❤️",
    items: parse(`
❤️ red heart love
🧡 orange heart
💛 yellow heart gold
💚 green heart
💙 blue heart
💜 purple heart
🖤 black heart
🤍 white heart
🤎 brown heart
💔 broken heart
❣️ heart exclamation
💕 two hearts
💞 revolving hearts
💓 beating heart
💗 growing heart
💖 sparkling heart
💘 heart arrow cupid
💝 heart ribbon gift
💟 heart decoration
☮️ peace
✝️ cross
☪️ star crescent
🕉️ om
☸️ dharma wheel
✡️ star of david
☯️ yin yang balance duality
♈ aries
♉ taurus
♊ gemini
♋ cancer
♌ leo
♍ virgo
♎ libra
♏ scorpio
♐ sagittarius
♑ capricorn
♒ aquarius
♓ pisces
🆔 id
⚛️ atom science
🉑 accept
☢️ radioactive
☣️ biohazard
📴 phone off
📳 vibration mode
🈶 not free
🚫 prohibited no
⛔ no entry
✅ check tick done yes
☑️ ballot check
✔️ check mark
❌ cross wrong no
❎ cross mark button
➕ plus add
➖ minus
➗ divide
✖️ multiply
♾️ infinity forever
‼️ double exclamation
⁉️ exclamation question
❓ question
❔ white question
❕ white exclamation
❗ exclamation
〰️ wavy dash
💯 hundred perfect score
🔅 dim
🔆 bright
📶 signal bars
🔱 trident
⚠️ warning caution
🚸 children crossing
⚜️ fleur de lis
🔰 beginner
♻️ recycle
✳️ eight spoked asterisk
❇️ sparkle
™️ trademark
©️ copyright
®️ registered
#️⃣ hash
*️⃣ asterisk
0️⃣ zero
1️⃣ one
2️⃣ two
3️⃣ three
🔠 letters
🔡 lowercase
🔤 abc
🔴 red circle
🟠 orange circle
🟡 yellow circle
🟢 green circle
🔵 blue circle
🟣 purple circle
⚫ black circle
⚪ white circle
🟥 red square
🟧 orange square
🟨 yellow square
🟩 green square
🟦 blue square
🟪 purple square
⬛ black square
⬜ white square
🔶 orange diamond
🔷 blue diamond
🔸 small orange diamond
🔹 small blue diamond
🔺 red triangle up
🔻 red triangle down
💠 diamond dot
🔘 radio button
🔳 white square button
🔲 black square button
`),
  },
];

/** The reactions offered on the hover bar — the six people actually use. */
export const QUICK_REACTIONS = ["❤️", "👍", "😂", "😮", "😢", "🙏"];

/** Search every group by keyword AND by glyph, so pasting an emoji finds it too. */
export function searchEmoji(q: string, limit = 60): Emoji[] {
  const term = q.trim().toLowerCase();
  if (!term) return [];
  const starts: Emoji[] = [];
  const contains: Emoji[] = [];
  for (const g of EMOJI_GROUPS) {
    for (const e of g.items) {
      if (e.c === term) return [e];
      const at = e.k.indexOf(term);
      if (at < 0) continue;
      // A word-start match ("cat" → 🐱) beats a mid-word one ("cat" → 🐛 caterpillar).
      (at === 0 || e.k[at - 1] === " " ? starts : contains).push(e);
      if (starts.length >= limit) return starts;
    }
  }
  return [...starts, ...contains].slice(0, limit);
}

// ── Recently used (this device only) ─────────────────────────────────────────
// localStorage, not the server: which emoji somebody reaches for is a behavioural trace, and this
// is an app whose entire database is public. It stays on the device that typed it.

const RECENT_KEY = "aq-emoji-recent";
const RECENT_MAX = 32;

export function recentEmoji(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function rememberEmoji(c: string): void {
  try {
    const next = [c, ...recentEmoji().filter((x) => x !== c)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* private mode / quota — recents are a convenience, never a requirement */ }
}
