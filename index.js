'use strict'
/*=============================================== USER CONFIGURATION ===============================================*/

const userConfig = {
  'binance': {
    'apiKey': 'xxx',
    'apiSecret': 'xxx',
  },
  'mail': {
    'username': 'xxx@gmail.com',
    'password': 'xxx',
    'host': 'imap.gmail.com',
    'port': 993,
    'mailbox': 'INBOX',
  }
}

/*=============================================== ADMIN CONFIGURATION ==============================================*/
/*============================================ DON'T EDIT BELOW THIS LINE===========================================*/

const adminConfig = {
  'mail': {
    'maxMailAge': 60
  },
  'retry': {
    'retries': 30,
    'minTimeout': 1000,
    'maxTimeout': 6000,
  },
  'tradingview': {
    'mail': 'noreply@tradingview.com'
  }
}

const _ = require('lodash'),
  log = require('fancy-log'),
  logSymbols = require('log-symbols'),
  MailListener = require("mail-listener2-updated"),
  promiseRetry = require("promise-retry"),
  fetch = require("node-fetch"),
  crypto = require("crypto"),
  qs = require("qs")

const binance = require('binance-api-node').default
const chalk   = require('chalk')

// Binance API initialization //
const binance_client = binance({
  apiKey: userConfig.binance.apiKey,
  apiSecret: userConfig.binance.apiSecret,
  useServerTime: true,
})
log(logSymbols.info, 'Connected to ' + chalk.magenta('Binance'))

let runningMailHandler  = false
let trading             = {}
let stepSize            = {}
let total               = {}
let quantity            = {}
let balance             = {}
let buyPrice            = {}
let orderId             = {}

let mailListener = new MailListener({
  username: userConfig.mail.username,
  password: userConfig.mail.password,
  host: userConfig.mail.host,
  mailbox: userConfig.mail.mailbox,
  port: userConfig.mail.port,
  tls: true,
  tlsOptions: {rejectUnauthorized: false},
  markSeen: false
})

mailListener.start()

mailListener.on("server:connected", () => {
  log(logSymbols.success, `E-Mail listener connected to ${userConfig.mail.username}`)
  log(logSymbols.info, `Listening for new TradingView notifications...`)
})

mailListener.on("server:disconnected", () => {
  log(logSymbols.error, `E-Mail listener disconnected. Attempting reconnect...`)
  setTimeout(() => {
    mailListener.restart()
  }, 5* 1000)
})

mailListener.on("error", (err) => {
  log(logSymbols.error, "Mail Listener Error:", err)
})

mailListener.on("mail", (mail) => {
  runOneAtATime(mail)
})


/**
 * Handle new incoming emails
 * @param mail
 */
function handleMail(mail) {
  var email_text = ""
  if (mail.text) {
    email_text = mail.text
  }
  else if (mail.html) {
    email_text = mail.html
  }
  // E-Mail not from TradingView
  if (mail.from[0].address.toString() !== adminConfig.tradingview.mail) {
      log(logSymbols.info, `Email received from ${mail.from[0].address.toString()}. Ignoring since sender not TradingView.`);
      return;
  }
  // Old email -  do nothing
  if (new Date(mail.receivedDate) < new Date(Date.now() - adminConfig.mail.maxMailAge * 1000)) {
      log(logSymbols.info, `Email received from ${mail.from[0].address.toString()} but email already older than ${adminConfig.mail.maxMailAge}sec. Ignoring email. `);
      return;
  }
  // R-Mail content not readable - do nothing
  if (email_text === "") {
      log(logSymbols.error, `Email received from ${mail.from[0].address.toString()} but email content not readable. Ignoring email. `);
      return;
  }
  else {
    if ( email_text.includes("#BCE_ACTION_START#") ) {
        log(chalk.magenta("PROCESSING BINANCE ORDER"))
        Binance_trade(email_text)
    }
  }
}


/**
 * Run the Binance Trade
 * @param text
 */
function Binance_trade(email_text) {
  var action = email_text.substring(
      email_text.lastIndexOf("#BCE_ACTION_START#") + 18,
      email_text.lastIndexOf("#BCE_ACTION_END#")
  ).toUpperCase()
  log(chalk.grey("BINANCE ACTION: "), action)

  var pair = email_text.substring(
      email_text.lastIndexOf("#BCE_PAIR_START#") + 16,
      email_text.lastIndexOf("#BCE_PAIR_END#")
  ).toUpperCase()
  log(chalk.grey("PAIR: "), pair)

  // TD BUY ALERT TEXT FORMAT:
  // #BCE_ACTION_START#BUY#BCE_ACTION_END#
  // #BCE_PAIR_START#BTCUSDT#BCE_PAIR_END#
  // #BCE_TOT_START#15#BCE_TOT_END#
  if (action === 'BUY') {

    total[pair] = parseFloat(email_text.substring(
        email_text.lastIndexOf("#BCE_TOT_START#") + 15,
        email_text.lastIndexOf("#BCE_TOT_END#")
    ))
    log(chalk.grey("TOTAL VALUE: "), total[pair])

    if (trading[pair]) {
      // EXISTING TRADING PAIR //
      buy_at_market_price(pair)
    }
    else {
      // NEW TRADING PAIR
      // FIND OUT IF PAIR EXISTS:
      binance_client.exchangeInfo().then(results => {
        // CHECK IF PAIR IS UNKNOWN:
        if (_.filter(results.symbols, {symbol: pair}).length > 0) {
          // PAIR EXISTS
          stepSize[pair] = _.filter(results.symbols, {symbol: pair})[0].filters[1].stepSize
          buy_at_market_price(pair)
        }
        // PAIR UNKNOWN:
        else {
          log(chalk.yellow(pair + "  => This pair is unknown to Binance." ))
          return
        }
      })
    }
  }
  // TD SELL ALERT TEXT FORMAT:
  // #BCE_ACTION_START#SELL#BCE_ACTION_END#
  // #BCE_PAIR_START#BTCUSDT#BCE_PAIR_END#
  else if (action === 'SELL') {
    if (trading[pair] && balance[pair]) {
      log(chalk.keyword('orange')("SELLING " + balance[pair] + " OF " + pair + " AT MARKET PRICE" ))
      binance_client.order({
        symbol: pair,
        side: 'SELL',
        type: 'MARKET',
        quantity: balance[pair],
        recvWindow: 1000000
      })
      .then( order => {
        orderId[pair] = order.orderId
        log(logSymbols.success, chalk.grey("SELL MARKET ORDER SET "))
        check_market_order(pair, order.orderId)
        balance[pair] = 0
        quantity[pair] = 0
      })
      .catch( error => {
        log(logSymbols.error, "MARKET SELL ERROR " + error )
        return
      })
    }
    else {
      log(chalk.keyword('orange')("THIS PAIR IS NOT YET TRADED: " + pair ))
    }

  }
}

function buy_at_market_price(pair) {
  // GET ORDER BOOK TO FIND OUT OUR BUY PRICE
  binance_client.book({ symbol: pair }).then(results => {
    // SO WE CAN TRY TO BUY AT THE 1ST BID PRICE + %0.02:
    buyPrice[pair] = parseFloat(results.asks[0].price)
    log(chalk.grey("CURRENT 1ST ASK PRICE : " + buyPrice[pair]))
    var precision = stepSize[pair].toString().split('.')[1].length || 0
    quantity[pair] = (( ((total[pair] / buyPrice[pair]) / parseFloat(stepSize[pair])) | 0 ) * parseFloat(stepSize[pair])).toFixed(precision)
    log(chalk.grey("BUYING " + quantity[pair] + " OF " + pair + " AT MARKET PRICE" ))
    // SETUP MARKET BUY ORDER
    binance_client.order({
      symbol: pair,
      side: 'BUY',
      type: 'MARKET',
      quantity: quantity[pair],
      recvWindow: 1000000
    })
    .then((order) => {
      orderId[pair] = order.orderId
      trading[pair] = true
      if (balance[pair]) {
        var precision = stepSize[pair].toString().split('.')[1].length || 0
        balance[pair] = (parseFloat(balance[pair]) + parseFloat(quantity[pair])).toFixed(precision)
      }
      else {
        balance[pair] = quantity[pair]
      }
      log(logSymbols.success, chalk.grey("BUY MARKET ORDER SET"))
      check_market_order(pair, order.orderId)
    })
    .catch((error) => {
      log(logSymbols.error, "BUY MARKET ERROR " + error)
    })
  })
}


function check_market_order(pair, orderId) {
  binance_client.getOrder({
    symbol: pair,
    orderId: orderId,
    recvWindow: 1000000
  })
  .then( order => {
    if (order.status === "FILLED") {
      log(logSymbols.success, chalk.gray("MARKET ORDER FILLED "))
      return
    }
    else {
      log(logSymbols.warning, chalk.gray("MARKET ORDER NOT YET FILLED "))
      check_market_order(pair, orderId)
    }
  })
  .catch( error => {
    //log(logSymbols.error, "CHECK MARKET ORDER API ERROR " + error )
    return
  })
}


/**
 * Make sure that only one mail is being handled at a time
 */
function runOneAtATime(mail) {
  if (runningMailHandler) {
    setTimeout(runOneAtATime, 100, mail);
  }
  else {
    runningMailHandler = true;
    handleMail(mail);
    log(logSymbols.info, 'Listening for new TradeingView notifications...');
    runningMailHandler = false;
  }
}
