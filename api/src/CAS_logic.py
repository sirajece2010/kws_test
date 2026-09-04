from datetime import datetime, timezone
from kite_trade import KiteApp
import time
import psycopg2
import json
from pathlib import Path

ltp_data = {}
enctoken = 'hsW0Xg95cvanbuj+o1Kajp4teYKSsD3xvSsvEFZd/Y/gQJAB4WHobeSQrwCxrEayFH7gdwi6VdthKaFk+wOX9/L1VulIUdvt6tPAtxEdPeXTLbXzVIZm9g=='

with Path(__file__).with_name('nifty_index_weightage.json').open(encoding='utf-8') as weightage_file:
    nifty_index_weightage = json.load(weightage_file)['w']['NIFTY']

conn = psycopg2.connect(
    dbname="marketdata",
    user="postgres",
    password="postgres",
    host="localhost",
    port="5112"
)


# CAS Strategy - Trade Direction at 3:20 PM
def cas_strategy_320():
    """
    CAS (Close Above/Below Support) Strategy
    Finds trade direction at 3:20 PM based on price position vs key levels
    """
    current_time = datetime.now().time()
    current_time = datetime.strptime("15:20", "%H:%M").time()
    target_time = datetime.strptime("15:20", "%H:%M").time()
    
    if current_time == target_time:
        # Get current price and support/resistance levels
        current_price = get_current_price()
        support = get_support_level()
        resistance = get_resistance_level()
        
        # Determine trade direction
        if current_price > resistance:
            trade_direction = "LONG"
        elif current_price < support:
            trade_direction = "SHORT"
        else:
            trade_direction = "NEUTRAL"
        
        return trade_direction
    
    return None


def get_current_price():
    """
    Placeholder function to get the current price.
    Replace with actual implementation to fetch live price.
    """
    return 80  # Example static price for testing purposes

def get_support_level():
    """
    Placeholder function to get the support level.
    Replace with actual implementation to fetch support level.
    """
    return 95  # Example static support level for testing purposes

def get_resistance_level():
    """
    Placeholder function to get the resistance level.
    Replace with actual implementation to fetch resistance level.
    """
    return 105  # Example static resistance level for testing purposes

#websocket implementation
niftyindexheavyweight = {17512194: 'NIFTY26SEPFUT', 256265: 'NIFTY 50', 260105: 'BANKNIFTY', 341249: 'HDFCBANK', 1270529: 'ICICIBANK', 738561: 'RELIANCE', 2714625: 'BHARTIARTL', 2939649: 'LT', 779521: 'SBIN', 408065: 'INFY'}
#stock = {291849: 'GIFT NIFTY',256265: 'NIFTY 50', 265: 'SENSEX'}
stock = dict(niftyindexheavyweight)
#stock = {341249: 'HDFCBANK'}

RUNTIME_SYMBOLS_FILE = Path(__file__).with_name('cas_symbols.json')

def load_runtime_symbols():
    try:
        with RUNTIME_SYMBOLS_FILE.open(encoding='utf-8') as symbols_file:
            runtime_symbols = json.load(symbols_file).get('symbols', {})
    except (FileNotFoundError, json.JSONDecodeError):
        return set()

    added_tokens = set()
    for token, symbol in runtime_symbols.items():
        try:
            instrument_token = int(token)
        except (TypeError, ValueError):
            continue
        if isinstance(symbol, str) and symbol.strip() and stock.get(instrument_token) != symbol.strip():
            stock[instrument_token] = symbol.strip()
            added_tokens.add(instrument_token)
    return added_tokens

load_runtime_symbols()

def on_ticks(ws, ticks):
    for sym in ticks:
        #ltp_data[stock[sym['instrument_token']]] = {"ltp": sym["last_price"]}
        symbol = stock.get(sym['instrument_token'])
        if symbol:
            ltp_data[symbol] = sym

def on_connect(ws, response):
    kws = KiteApp(enctoken=enctoken).kws("UVP969")
    MODE = kws.MODE_FULL  #other modes MODE_FULL, MODE_QUOTE, MODE_LTP
    ws.subscribe(list(stock.keys()))
    ws.set_mode(MODE,list(stock.keys()))

def start_websocket():
    kite_app = KiteApp(enctoken=enctoken)
    kws = kite_app.kws("UVP969")  
    kws.on_ticks = on_ticks
    kws.on_connect = on_connect
    kws.connect(threaded=True)
    return kws


if __name__ == "__main__":
    trade_direction = cas_strategy_320()
    if trade_direction:
        print(f"Trade direction at 3:20 PM: {trade_direction}")
    else:
        print("Not the target time yet.")

    cur = conn.cursor()
    kws = start_websocket()
    time.sleep(1)

    first_change = {}
    first_volume = {}
    for symbol, data in ltp_data.items():
        first_change[symbol] = data['change'] if 'change' in data else 0
        first_volume[symbol] = data.get('volume_traded', 0)
        print(f"Symbol: {symbol}, Change%: {first_change[symbol]}, Volume: {first_volume[symbol]}")

    while True:
        time.sleep(1)  # Wait for websocket to receive data
        new_tokens = load_runtime_symbols()
        if new_tokens:
            kws.subscribe(list(new_tokens))
            kws.set_mode(kws.MODE_FULL, list(new_tokens))
        #print(ltp_data)
        for symbol, data in ltp_data.items():
            weight = nifty_index_weightage.get(symbol, 0.20)
            cur.execute("INSERT INTO ticks (time, symbol, ltp, open, high, low, close, volume, change, change_delta, volume_delta, weight) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)", (datetime.now(timezone.utc).replace(microsecond=0), symbol, data['last_price'], data['ohlc']['open'], data['ohlc']['high'], data['ohlc']['low'], data['ohlc']['close'], data.get('volume_traded',0), data['change'], data['change']-first_change[symbol], data.get('volume_traded',0)-first_volume[symbol], weight))
        print(f"delta from first change for {symbol}: {data['change']-first_change[symbol]}, delta from first volume: {data.get('volume_traded',0)-first_volume[symbol]}")
        conn.commit()