
const socket = io();
const $ = id => document.getElementById(id);

let roomCode = "";
let state = null;
let lastState = null;
let pendingWildIndex = null;

const CARD_IMAGES = "/cards/";

const COLOR_LETTERS = {
  red: "R",
  blue: "B",
  green: "G",
  yellow: "Y"
};

const COLOR_HEX = {
  red: "#ed2939",
  blue: "#2879dc",
  green: "#169b62",
  yellow: "#f2c500"
};


const imageCache = new Map();


/* ===== SOUND EFFECTS + BACKGROUND MUSIC ===== */

const SFX_PATH = "/sfx/";

const sounds = {
  music: new Audio(SFX_PATH + "bg-theme.mp3"),
  draw2: new Audio(SFX_PATH + "draw2.mp3"),
  draw4: new Audio(SFX_PATH + "draw4.mp3"),
  drawCards: new Audio(SFX_PATH + "draw-cards.mp3"),
  reverseClockwise: new Audio(SFX_PATH + "reverse-clockwise.mp3"),
  reverseAnticlockwise: new Audio(SFX_PATH + "reverse-anticlockwise.mp3"),
  skip: new Audio(SFX_PATH + "skip.mp3"),
  wildConfirm: new Audio(SFX_PATH + "wild-confirm.mp3"),
  wildPopup: new Audio(SFX_PATH + "wild-popup.mp3"),
  turnReady: new Audio(SFX_PATH + "turn-ready.mp3")
};

sounds.music.loop = true;
sounds.music.volume = 0.25;

for (const [name, audio] of Object.entries(sounds)) {
  if (name !== "music") audio.volume = 0.65;
}

function playSound(name) {
  const audio = sounds[name];
  if (!audio) return;

  // Restart short effects so quick actions still play clearly.
  if (name !== "music") {
    audio.pause();
    audio.currentTime = 0;
  }

  audio.play().catch(() => {
    // Browsers may block audio until the player interacts with the page.
  });
}

function startBackgroundMusic() {
  if (sounds.music.paused) {
    playSound("music");
  }
}

/* ===== SPINNING DIRECTION SYMBOL ===== */

let directionSymbol = null;
let previousDirection = null;

function setupDirectionSymbol() {
  const center = document.querySelector(".center-table");
  if (!center || directionSymbol) return;

  directionSymbol = document.createElement("img");
  directionSymbol.id = "directionSymbol";
  directionSymbol.alt = "Current play direction";
  directionSymbol.draggable = false;

  center.appendChild(directionSymbol);
}

function updateDirectionSymbol(direction) {
  setupDirectionSymbol();
  if (!directionSymbol) return;

  const clockwise = direction === 1;

  directionSymbol.src = clockwise
    ? "/symbols/spinning-clockwise.png"
    : "/symbols/spinning-anticlockwise.png";

  directionSymbol.classList.toggle("clockwise", clockwise);
  directionSymbol.classList.toggle("anticlockwise", !clockwise);
}

function handleGameEffects(previous, next) {
  if (!next.started || !next.game) return;

  if (!previous?.started) {
    startBackgroundMusic();
    previousDirection = next.game.direction;
    updateDirectionSymbol(next.game.direction);
    return;
  }

  const oldGame = previous.game;
  const newGame = next.game;

  if (!oldGame || !newGame) return;

  // Update the direction symbol when direction changes.
  if (oldGame.direction !== newGame.direction) {
    previousDirection = newGame.direction;
    updateDirectionSymbol(newGame.direction);

    playSound(
      newGame.direction === 1
        ? "reverseClockwise"
        : "reverseAnticlockwise"
    );
  } else {
    updateDirectionSymbol(newGame.direction);
  }

  // Detect a newly played special card.
  const oldTop = oldGame.top;
  const newTop = newGame.top;

  const topChanged = oldTop &&
    newTop &&
    (oldTop.color !== newTop.color ||
     oldTop.value !== newTop.value);

  if (topChanged) {
    if (newTop.value === "Draw2") playSound("draw2");
    else if (newTop.value === "Wild4") playSound("draw4");
    else if (newTop.value === "Skip") playSound("skip");
  }

  // Play a sound when your turn starts.
  const wasMyTurn = previous.players?.some(
    player => player.id === socket.id && player.isTurn
  );

  const isMyTurn = next.players?.some(
    player => player.id === socket.id && player.isTurn
  );

  if (!wasMyTurn && isMyTurn && !newGame.winner) {
    playSound("turnReady");
  }

  // Detect cards added to your hand after the game was already running.
  if (Array.isArray(previous.hand) && Array.isArray(next.hand)) {
    if (next.hand.length > previous.hand.length) {
      playSound("drawCards");
    }
  }
}


/* ===== PAGE NAVIGATION ===== */

function showPage(pageId) {
  document.querySelectorAll(".page").forEach(page => {
    page.classList.add("hidden");
  });

  const page = $(pageId);
  if (page) page.classList.remove("hidden");
}

$("getInButton").onclick = () => showPage("gamesMenu");
$("homeButton").onclick = () => showPage("mainMenu");
$("unoTile").onclick = () => showPage("lobby");
$("gamesButton").onclick = () => showPage("gamesMenu");
$("backToLobby").onclick = () => showPage("lobby");

/* ===== CONNECTION ===== */

socket.on("connect", () => {
  $("status").textContent = "Connected.";
});

socket.on("disconnect", () => {
  $("status").textContent = "Connection lost. Reconnecting...";
});

socket.on("notice", text => {
  $("status").textContent = text;
  $("lobbyStatus").textContent = text;
  $("gameMessage").textContent = text;
});

/* ===== ROOM CONTROLS ===== */

$("createRoom").onclick = () => {
  socket.emit("createRoom", $("playerName").value);
};

$("joinRoom").onclick = () => {
  socket.emit("joinRoom", {
    name: $("playerName").value,
    code: $("roomCode").value
  });
};

socket.on("joined", code => {
  roomCode = code;
  $("codeLabel").textContent = code;
  showPage("unoRoom");
});

$("copyCode").onclick = async () => {
  try {
    await navigator.clipboard.writeText(roomCode);
    $("lobbyStatus").textContent = "Room code copied!";
  } catch {
    $("lobbyStatus").textContent = "Your room code is " + roomCode;
  }
};

$("startGame").onclick = () => socket.emit("startGame");
$("leaveGame").onclick = () => location.reload();
$("drawCard").onclick = () => socket.emit("drawCard");

$("sayUno").onclick = () => {
  $("gameMessage").textContent =
    "UNO call is visual only in this prototype.";
};

/* ===== LOBBY MODIFIER CONTROLS ===== */

const modifierIds = {
  stacking: "modStacking",
  zeroSeven: "modZeroSeven",
  drawUntilPlayable: "modDrawUntil",
  sixReaction: "modSixReaction"
};

function readModifierSettings() {
  const settings = {};

  for (const [key, id] of Object.entries(modifierIds)) {
    const input = $(id);
    if (input) settings[key] = input.checked;
  }

  const startingCards = $("startingCards");
  settings.startingCards = startingCards
    ? Number(startingCards.value)
    : 7;

  return settings;
}

function sendModifierSettings() {
  if (
    !lastState ||
    socket.id !== lastState.hostId ||
    lastState.started
  ) {
    return;
  }

  socket.emit("updateSettings", readModifierSettings());
}

for (const id of [
  ...Object.values(modifierIds),
  "startingCards"
]) {
  const input = $(id);

  if (input) {
    input.addEventListener("change", sendModifierSettings);
  }
}

function renderModifierSettings(next) {
  const settings = next.settings || {
    stacking: false,
    jumpIn: false,
    zeroSeven: false,
    drawUntilPlayable: false,
    sixReaction: false,
    startingCards: 7
  };

  const isHost = socket.id === next.hostId;
  const panel = $("modifierPanel");

  if (panel) panel.hidden = !!next.started;

  for (const [key, id] of Object.entries(modifierIds)) {
    const input = $(id);
    if (!input) continue;

    input.checked = !!settings[key];
    input.disabled = !isHost || !!next.started;
  }

  const startingCards = $("startingCards");

  if (startingCards) {
    startingCards.value = String(settings.startingCards || 7);
    startingCards.disabled = !isHost || !!next.started;
  }

  const permission = $("modifierPermission");

  if (permission) {
    permission.textContent = isHost
      ? "You're the host. Change these settings before starting."
      : "Only the host can change these settings.";
  }
}

/* ===== CARD IMAGES ===== */

function cardFilename(card) {
  const letter = COLOR_LETTERS[card.color];

  if (card.color === "wild") {
    return card.value === "Wild4" ? "W4.png" : "WC.png";
  }

  if (!letter) return null;

  const specialNames = {
    Skip: "S",
    Reverse: "R",
    Draw2: "A2"
  };

  const suffix = specialNames[card.value] ?? card.value;

  return `${letter}${suffix}.png`;
}


function loadCardImage(filename) {
  if (!imageCache.has(filename)) {
    const image = new Image();
    let attempts = 0;
    const maxAttempts = 3;

    image.onload = () => {
      imageCache.set(filename, image);
    };

    image.onerror = () => {
      attempts++;

      if (attempts < maxAttempts) {
        console.warn(
          `Retrying card image (${attempts + 1}/${maxAttempts}): ${filename}`
        );

        image.src =
          CARD_IMAGES +
          filename +
          "?retry=" + attempts +
          "&t=" + Date.now();
      } else {
        console.error(
          `Card image failed after ${maxAttempts} attempts: ${filename}`
        );
      }
    };

    image.src = CARD_IMAGES + filename;
    imageCache.set(filename, image);
  }

  return imageCache.get(filename);
}


/*
 * Recolor the dark background of a Wild card while preserving
 * its bright lettering and symbols.
 */
function recolorWildImage(image, chosenColor) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;

  const context = canvas.getContext("2d", {
    willReadFrequently: true
  });

  context.drawImage(image, 0, 0);

  const imageData = context.getImageData(
    0,
    0,
    canvas.width,
    canvas.height
  );

  const pixels = imageData.data;
  const hex = COLOR_HEX[chosenColor];

  if (!hex) return image.src;

  const replacement = {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16)
  };

  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];

    const brightness = (r + g + b) / 3;
    const maxChannel = Math.max(r, g, b);
    const minChannel = Math.min(r, g, b);
    const saturation = maxChannel - minChannel;

    if (brightness < 75 && saturation < 45) {
      const amount = 0.35 + (1 - brightness / 75) * 0.65;

      pixels[i] = Math.round(
        r * (1 - amount) + replacement.r * amount
      );

      pixels[i + 1] = Math.round(
        g * (1 - amount) + replacement.g * amount
      );

      pixels[i + 2] = Math.round(
        b * (1 - amount) + replacement.b * amount
      );
    }
  }

  context.putImageData(imageData, 0, 0);

  return canvas.toDataURL("image/png");
}

function makeCard(card, small = false, chosenColor = null) {
  const button = document.createElement("button");

  button.className = "card " +
    (card.color === "wild" ? "wild-card" : card.color);

  button.title = `${card.color} ${card.value}`;

  const filename = cardFilename(card);

  if (!filename) {
    button.textContent = String(card.value);
    return button;
  }

  const image = loadCardImage(filename);

  function displayImage() {
    if (!image.complete || !image.naturalWidth) {
      button.textContent = String(card.value);
      return;
    }

    const img = document.createElement("img");

    img.alt = `${card.color} ${card.value}`;
    img.draggable = false;
    img.className = "uno-card-image";

    if (card.color === "wild" && chosenColor) {
      img.src = recolorWildImage(image, chosenColor);
    } else {
      img.src = image.src;
    }

    button.replaceChildren(img);
  }

  if (image.complete && image.naturalWidth) {
    displayImage();
  } else {
    image.onload = displayImage;

    image.onerror = () => {
      button.textContent = String(card.value);
      button.title = `Missing image: ${filename}`;
    };
  }

  return button;
}

/* ===== SIX REACTION ===== */

function renderSixReaction(next) {
  const panel = $("sixReactionPanel");
  const button = $("sixReactionButton");
  const text = $("sixReactionText");

  if (!panel || !button || !text) return;

  const reaction = next.game?.sixReaction;
  const active = !!reaction?.active;

  panel.hidden = !active;

  if (!active) return;

  const alreadyPressed =
    Array.isArray(reaction.pressed) &&
    reaction.pressed.includes(socket.id);

  text.textContent = alreadyPressed
    ? "You're safe! Waiting for the others..."
    : "A 6 was played! Tap before everyone else!";

  button.disabled = alreadyPressed;
  button.textContent = alreadyPressed
    ? "YOU'RE SAFE!"
    : "6! TAP TO BE SAFE";
}

const sixButton = $("sixReactionButton");

if (sixButton) {
  sixButton.addEventListener("click", () => {
    sixButton.disabled = true;
    socket.emit("pressSix");
  });
}

/* ===== RECEIVE GAME STATE ===== */

socket.on("state", next => {
  const previous = lastState;

  handleGameEffects(previous, next);

  state = next;
  lastState = next;

  renderModifierSettings(next);
  renderSixReaction(next);

  const gameStarted = !!next.started;

  if (gameStarted) {
    showPage("game");
  } else if (roomCode) {
    showPage("unoRoom");
  }

  if (!gameStarted) {
    $("playerList").replaceChildren();

    next.players.forEach(player => {
      const row = document.createElement("div");

      row.className = "player-item";
      row.textContent =
        player.name + (player.id === next.hostId ? " · HOST" : "");

      $("playerList").appendChild(row);
    });

    $("startGame").disabled =
      socket.id !== next.hostId || next.players.length < 2;

    $("startGame").textContent =
      next.players.length < 2
        ? "Waiting for another player"
        : "Start game";

    return;
  }

  const currentPlayer = next.players.find(player => player.isTurn);

  if ($("turnLabel")) {
  $("turnLabel").textContent = next.game.winner
    ? next.game.winner + " wins!"
    : (currentPlayer?.name || "Someone") + "'s turn";
}

if ($("deckLabel")) {
  $("deckLabel").textContent =
    next.game.drawCount + " cards left";
}

  /* ===== PLAYERS AROUND THE TABLE ===== */

  $("opponents").replaceChildren();

  const me = next.players.find(player => player.id === socket.id);

  $("myPlayerBadge").textContent = me
    ? `YOU · ${me.count}`
    : "YOU";

  $("myPlayerBadge").classList.toggle(
    "active",
    !!me?.isTurn
  );

  const otherPlayers = next.players.filter(
    player => player.id !== socket.id
  );

  const seats = ["seat-left", "seat-top", "seat-right"];

  otherPlayers.forEach((player, index) => {
    const seat = document.createElement("div");

    seat.className =
      `opponent-seat ${seats[index] || "seat-top"}`;

    const badge = document.createElement("div");

    badge.className =
      "opponent" + (player.isTurn ? " active" : "");

    badge.textContent = `${player.name} · ${player.count}`;

    const cards = document.createElement("div");

    cards.className = "opponent-cards";

    cards.setAttribute(
      "aria-label",
      `${player.count} hidden cards`
    );

    for (let i = 0; i < player.count; i++) {
      const img = document.createElement("img");

      img.src = "/cards/Back.jpg";
      img.alt = "Hidden card";
      img.draggable = false;
      img.className = "opponent-card-back";

      cards.appendChild(img);
    }

    seat.append(badge, cards);
    $("opponents").appendChild(seat);
  });

  /* ===== DISCARD PILE ===== */

  $("topCard").replaceChildren(
    makeCard(next.game.top, false, next.game.color)
  );

  /* ===== YOUR HAND ===== */

  $("myHand").replaceChildren();

  const isMyTurn =
    next.players[next.game.turn]?.id === socket.id;

  next.hand.forEach((card, index) => {
    const button = makeCard(card);

    const reactionActive = !!next.game.sixReaction?.active;

    button.disabled =
    !!next.game.winner ||
    !!next.game.drawing ||
    reactionActive;

    button.onclick = () => {
      if (card.color === "wild") {
  pendingWildIndex = index;
  playSound("wildPopup");
  $("colorPicker").classList.remove("hidden");
} else {
        socket.emit("playCard", { index });
      }
    };

    $("myHand").appendChild(button);
  });

  $("drawCard").disabled =
  !isMyTurn ||
  !!next.game.winner ||
  !!next.game.sixReaction?.active ||
  !!next.game.drawing ||
  !!next.game.drawnPlayable;

  
const myIndex = next.players.findIndex(
  player => player.id === socket.id
);

const response = next.game.penaltyResponse;

if (next.game.winner) {
  $("gameMessage").textContent =
    next.game.winner + " won the game!";
} else if (response && response.playerIndex === myIndex) {
  $("gameMessage").textContent =
    `You received a +${response.amount} penalty! ` +
    `Play a matching ${response.type === "Draw2" ? "+2" : "+4"} ` +
    `to stack it, or click Draw Card to accept ${response.amount} cards.`;
} else if (next.game.pendingDraw > 0) {
  $("gameMessage").textContent =
    `A +${next.game.pendingDraw} penalty is pending.`;
} else {
  $("gameMessage").textContent =
    next.game.color.toUpperCase() + " is the current color";
}

});

/* ===== WILD COLOR PICKER ===== */

document.querySelectorAll("[data-color]").forEach(button => {
  button.onclick = () => {
  if (pendingWildIndex === null) return;

  playSound("wildConfirm");

  socket.emit("playCard", {
    index: pendingWildIndex,
    color: button.dataset.color
  });

  pendingWildIndex = null;
  $("colorPicker").classList.add("hidden");
};
});

$("colorPicker").addEventListener("click", event => {
  if (event.target.id === "colorPicker") {
    pendingWildIndex = null;
    $("colorPicker").classList.add("hidden");
  }
});
