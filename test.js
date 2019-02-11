var email_text = "asdadasd#BCE_ACTION_START#BUY#BCE_ACTION_END##BCE_PAIR_START#ETHBTC#BCE_PAIR_END##BCE_TOT#0.001#BCE_TOT_START#asddasd#BCE_ACTION#BUY#BCE_ACTION##BCE_PAIR_START#ETHBTC#BCE_PAIR_END##BCE_TOT_START#0.001#BCE_TOT_END#asdasdasdasd"

var pair = email_text.substring(
    email_text.lastIndexOf("#BCE_TOT_START#") + 15,
    email_text.lastIndexOf("#BCE_TOT_END#")
);

console.log("BINANCE PAIR: " + pair)
