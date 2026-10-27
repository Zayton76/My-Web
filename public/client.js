
const socket = io();
const $ = id => document.getElementById(id);

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

function showPage(pageId) {
  document.querySelectorAll(".page").forEach(page => {
    page.classList.add("hidden");
  });

  $(pageId).classList.remove("hidden");
}

$("getInButton").onclick = () => showPage("gamesMenu");
$("homeButton").onclick = () => showPage("mainMenu");
$("unoTile").onclick = () => showPage("lobby");
$("gamesButton").onclick = () => showPage("gamesMenu");
$("backToLobby").onclick = () => showPage("lobby");

let roomCode = "";
let state = null;
let pendingWildIndex = null;

socket.on("connect", () => $("status").textContent = "Connected.");
socket.on("disconnect", () => {
  $("status").textContent = "Connection lost. Reconnecting...";
});

socket.on("notice", text => {
  $("status").textContent = text;
  $("lobbyStatus").textContent = text;
  $("gameMessage").textContent = text;
});

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
    image.src = CARD_IMAGES + filename;
    imageCache.set(filename, image);
  }

  return imageCache.get(filename);
}

/*
 * Recolor the dark/black background of a Wild card while keeping
 * its white symbols and lettering intact.
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
    0, 0, canvas.width, canvas.height
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

    /*
     * Change near-black, nearly neutral pixels only.
     * Bright white lettering and colored symbols are preserved.
     * The threshold can be adjusted if your artwork uses dark gray
     * rather than pure black for its background.
     */
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

socket.on("state", next => {
  state = next;

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

  const currentPlayer = next.players.find(p => p.isTurn);

  $("turnLabel").textContent = next.game.winner
    ? next.game.winner + " wins!"
    : (currentPlayer?.name || "Someone") + "'s turn";

  $("deckLabel").textContent = next.game.drawCount + " cards left";

  $("opponents").replaceChildren();

  next.players.forEach(player => {
    const badge = document.createElement("div");
    badge.className = "opponent" + (player.isTurn ? " active" : "");
    badge.textContent = player.id === socket.id
      ? "YOU · " + player.count
      : player.name + " · " + player.count;

    $("opponents").appendChild(badge);
  });

  $("topCard").replaceChildren(
    makeCard(next.game.top, false, next.game.color)
  );

  $("myHand").replaceChildren();

  const isMyTurn =
    next.players[next.game.turn]?.id === socket.id;

  next.hand.forEach((card, index) => {
    const button = makeCard(card);

    button.disabled = !isMyTurn || !!next.game.winner;

    button.onclick = () => {
      if (card.color === "wild") {
        pendingWildIndex = index;
        $("colorPicker").classList.remove("hidden");
      } else {
        socket.emit("playCard", { index });
      }
    };

    $("myHand").appendChild(button);
  });

  $("drawCard").disabled = !isMyTurn || !!next.game.winner;

  $("gameMessage").textContent = next.game.winner
    ? next.game.winner + " won the game!"
    : next.game.color.toUpperCase() + " is the current color";
});

document.querySelectorAll("[data-color]").forEach(button => {
  button.onclick = () => {
    if (pendingWildIndex === null) return;

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

