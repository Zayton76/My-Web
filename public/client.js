const socket = io();

const $ = id => document.getElementById(id);

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
socket.on("disconnect", () => $("status").textContent = "Connection lost. Reconnecting...");
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

function cardLabel(card) {
  const names = {
    Skip: "⊘",
    Reverse: "⇄",
    Draw2: "+2",
    Wild: "WILD",
    Wild4: "+4"
  };
  return names[card.value] || card.value;
}

function makeCard(card, small = false) {
  const button = document.createElement("button");
  button.className = "card " +
    (card.color === "wild" ? "wild-card" : card.color);
  button.textContent = cardLabel(card);
  button.title = card.color + " " + card.value;
  if (card.color === "wild") {
    button.style.background =
      "conic-gradient(#e8414f 0 25%,#e5b92e 0 50%,#169b62 0 75%,#2775dc 0)";
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

    next.players.forEach((player, index) => {
      const row = document.createElement("div");
      row.className = "player-item";
      row.textContent =
        player.name + (player.id === next.hostId ? " · HOST" : "");
      $("playerList").appendChild(row);
    });

    $("startGame").disabled =
      socket.id !== next.hostId || next.players.length < 2;
    $("startGame").textContent =
      next.players.length < 2 ? "Waiting for another player" : "Start game";
    return;
  }

  $("turnLabel").textContent = next.game.winner
    ? next.game.winner + " wins!"
    : next.players.find(p => p.isTurn)?.name + "'s turn";

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

  $("topCard").replaceChildren(makeCard(next.game.top));
  $("myHand").replaceChildren();

  const isMyTurn = next.players[next.game.turn]?.id === socket.id;

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
