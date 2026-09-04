import json
import os, sys
import random
import pandas as pd
from six.moves.urllib.parse import urljoin
from kiteconnect import KiteTicker

import requests
import dateutil.parser
import pandas as pd

#variables to define:
path = os.path.dirname(__file__)
session_file = f"{path}/json/session.txt"

def decorate_data(func):
    # pd.set_option('display.max_columns', None)
    def inner(*args, **kwargs):
        x = func(*args, **kwargs)
        return pd.DataFrame(x)

    return inner

def _write_cookie_file(cookie_dict):
    with open(session_file, "w") as fh:
        fh.write(json.dumps(cookie_dict, indent=2))

def _read_cookie_file(filename):
    with open(filename,"r") as fh:
        return json.load(fh)

def _validate_entoken(token):
    headers = {"Authorization": f"enctoken {token}"}
    session = requests.session()
    prof_url = "https://kite.zerodha.com/oms/user/profile/full"
    res = session.get(prof_url, headers=headers)
    return True if res.status_code == 200 else False

def _auth(userid, password, tfa_otp):
    valid_token = False
    if os.path.isfile(session_file):
        cookies_dict = _read_cookie_file(session_file)
        if 'enctoken' in cookies_dict.keys() and _validate_entoken(cookies_dict['enctoken']):
            valid_token = True
    if valid_token:
        return cookies_dict,None

    session = requests.Session()
    response = session.post('https://kite.zerodha.com/api/login', data={
        "user_id": userid,
        "password": password
    })
    response = session.post('https://kite.zerodha.com/api/twofa', data={
        "request_id": response.json()['data']['request_id'],
        "twofa_value": tfa_otp,
        "twofa_type": 'totp',
        "user_id": response.json()['data']['user_id']
    })
    cookie_dict = dict(session.cookies)

    #delete unnecessary keys to save space
    valid_cookies = dict()
    for key,val in cookie_dict.items():
        if key not in ["__cf_bm","_cfuvid","user_id"]:
            valid_cookies[key]=val
    _write_cookie_file(valid_cookies)
    return valid_cookies,response


def generate_enctoken(userid, password, tfa_otp):
    session_cookie,response = _auth(userid, password,tfa_otp)
    enctoken = session_cookie.get('enctoken')
    if enctoken:
        return enctoken
    else:
        return response.text

class KiteApp:
    # Products
    PRODUCT_MIS = "MIS"
    PRODUCT_CNC = "CNC"
    PRODUCT_NRML = "NRML"
    PRODUCT_CO = "CO"

    # Order types
    ORDER_TYPE_MARKET = "MARKET"
    ORDER_TYPE_LIMIT = "LIMIT"
    ORDER_TYPE_SLM = "SL-M"
    ORDER_TYPE_SL = "SL"

    # Varities
    VARIETY_REGULAR = "regular"
    VARIETY_CO = "co"
    VARIETY_AMO = "amo"

    # Transaction type
    TRANSACTION_TYPE_BUY = "BUY"
    TRANSACTION_TYPE_SELL = "SELL"

    # Validity
    VALIDITY_DAY = "DAY"
    VALIDITY_IOC = "IOC"

    # Exchanges
    EXCHANGE_NSE = "NSE"
    EXCHANGE_BSE = "BSE"
    EXCHANGE_NFO = "NFO"
    EXCHANGE_CDS = "CDS"
    EXCHANGE_BFO = "BFO"
    EXCHANGE_MCX = "MCX"

    _routes = {
        "api.token": "/session/token",
        "api.token.invalidate": "/session/token",
        "api.token.renew": "/session/refresh_token",
        "user.profile": "/user/profile",
        "user.margins": "/user/margins",
        "user.margins.segment": "/user/margins/{segment}",

        "orders": "/orders",
        "trades": "/trades",

        "order.info": "/orders/{order_id}",
        "order.place": "/orders/{variety}",
        "order.modify": "/orders/{variety}/{order_id}",
        "order.cancel": "/orders/{variety}/{order_id}",
        "order.trades": "/orders/{order_id}/trades",

        "portfolio.positions": "/portfolio/positions",
        "portfolio.holdings": "/portfolio/holdings",
        "portfolio.holdings.auction": "/portfolio/holdings/auctions",
        "portfolio.positions.convert": "/portfolio/positions",

        # MF api endpoints
        "mf.orders": "/mf/orders",
        "mf.order.info": "/mf/orders/{order_id}",
        "mf.order.place": "/mf/orders",
        "mf.order.cancel": "/mf/orders/{order_id}",

        "mf.sips": "/mf/sips",
        "mf.sip.info": "/mf/sips/{sip_id}",
        "mf.sip.place": "/mf/sips",
        "mf.sip.modify": "/mf/sips/{sip_id}",
        "mf.sip.cancel": "/mf/sips/{sip_id}",

        "mf.holdings": "/mf/holdings",
        "mf.instruments": "/mf/instruments",

        "market.instruments.all": "/instruments",
        "market.instruments": "/instruments/{exchange}",
        "market.margins": "/margins/{segment}",
        "market.historical": "/instruments/historical/{instrument_token}/{interval}",
        "market.trigger_range": "/instruments/trigger_range/{transaction_type}",

        "market.quote": "/quote",
        "market.quote.ohlc": "/quote/ohlc",
        "market.quote.ltp": "/quote/ltp",

        # GTT endpoints
        "gtt": "/gtt/triggers",
        "gtt.place": "/gtt/triggers",
        "gtt.info": "/gtt/triggers/{trigger_id}",
        "gtt.modify": "/gtt/triggers/{trigger_id}",
        "gtt.delete": "/gtt/triggers/{trigger_id}",

        # Margin computation endpoints
        "order.margins": "/margins/orders",
        "order.margins.basket": "/margins/basket"
    }

    def __init__(self, enctoken):
        self.enctoken = enctoken
        self.headers = {"Authorization": f"enctoken {enctoken}"}
        self.session = requests.session()
        #self.root_url = "https://api.kite.trade"
        self.root_url = "https://kite.zerodha.com/oms"
        self.kws_url = "wss://ws.kite.trade"
        self.session.get(self.root_url, headers=self.headers)
    
    def kws(self, user_id):
        return KiteTicker(api_key='kitefront',access_token=self.enctoken+"&user_id="+user_id,root=self.kws_url)

    def instruments(self, exchange=None):
        url = "https://api.kite.trade"
        data = self.session.get(f"{url}/instruments",headers=self.headers).text.split("\n")
        Exchange = []
        for i in data[1:-1]:
            row = i.split(",")
            if exchange is None or exchange == row[11]:
                Exchange.append({'instrument_token': int(row[0]), 'exchange_token': row[1], 'tradingsymbol': row[2],
                                 'name': row[3][1:-1], 'last_price': float(row[4]),
                                 'expiry': dateutil.parser.parse(row[5]).date() if row[5] != "" else None,
                                 'strike': float(row[6]), 'tick_size': float(row[7]), 'lot_size': int(row[8]),
                                 'instrument_type': row[9], 'segment': row[10],
                                 'exchange': row[11]})
        return Exchange

    def quote(self, instruments):
        data = self.session.get(f"{self.root_url}/quote", params={"i": instruments}, headers=self.headers).json()
        return data["data"] if data.__contains__("data") else data

    def profile(self):
        route = 'user.profile'
        uri = self._routes[route]
        get_profile = self.session.get(urljoin(self.root_url, uri), headers=self.headers).json()["data"]
        return get_profile

    def ltp(self, instruments):
        data = self.session.get(f"{self.root_url}/quote/ltp", params={"i": instruments}, headers=self.headers).json()
        return data["data"] if data.__contains__("data") else data

    def historical_data(self, instrument_token, from_date, to_date, interval, continuous=False, oi=False):
        params = {"from": from_date,
                  "to": to_date,
                  "interval": interval,
                  "continuous": 1 if continuous else 0,
                  "oi": 1 if oi else 0}
        lst = self.session.get(
            f"{self.root_url}/instruments/historical/{instrument_token}/{interval}", params=params,
            headers=self.headers).json()["data"]["candles"]
        print(lst)
        records = []
        for i in lst:
            record = {"date": i[0], "open": i[1], "high": i[2], "low": i[3],
                      "close": i[4], "volume": i[5], "candle_color": "Green" if i[4] > i[1] else "Red",
                      "candle_delta": round(i[4] - i[1], 2)}
            if len(i) == 7:
                record["oi"] = i[6]
            records.append(record)
        return records

    def depth(self,instrument):
        data= self.quote(instrument)
        return pd.DataFrame(data[instrument]['depth'])

    def margins(self):
        margins = self.session.get(f"{self.root_url}/user/margins", headers=self.headers).json()["data"]
        return margins['equity']

    #@decorate_data
    def orders(self):
        orders = self.session.get(f"{self.root_url}/orders", headers=self.headers).json()["data"]
        return orders

    #@decorate_data
    def order_history(self, order_id):
        route='order.info'; url_args= {'order_id':order_id}
        uri = self._routes[route].format(**url_args)
        order_his = self.session.get(urljoin(self.root_url, uri), headers=self.headers).json()["data"]
        return order_his

    @decorate_data
    def trades(self):
        trades = self.session.get(f"{self.root_url}/trades", headers=self.headers).json()["data"]
        return trades

    def order_trades(self,order_id):
        order_trades = self.session.get(f"{self.root_url}/orders/{order_id}/trades", headers=self.headers).json()["data"]
        return order_trades

    def positions(self):
        positions = self.session.get(f"{self.root_url}/portfolio/positions", headers=self.headers).json()["data"]
        return positions

    def holdings(self):
        return self.session.get(f"{self.root_url}/portfolio/holdings", headers=self.headers).json()["data"]

    def place_order(self, variety, exchange, tradingsymbol, transaction_type, quantity, product, order_type, price=None,
                    validity=None, disclosed_quantity=None, trigger_price=None, squareoff=None, stoploss=None,
                    trailing_stoploss=None, tag=None):
        params = locals()
        del params["self"]
        print(params)
        for k in list(params.keys()):
            if params[k] is None:
                del params[k]
        try:
            transact = self.session.post(f"{self.root_url}/orders/{variety}",
                                         data=params, headers=self.headers).json()
            order_id = transact["data"]["order_id"]
        except Exception:
            print("ERROR:",transact['message'])
            return transact["data"]
        return order_id

    def modify_order(self, variety, order_id, parent_order_id=None, quantity=None, price=None, order_type=None,
                     trigger_price=None, validity=None, disclosed_quantity=None):
        params = locals()
        del params["self"]
        for k in list(params.keys()):
            if params[k] is None:
                del params[k]

        order_id = self.session.put(f"{self.root_url}/orders/{variety}/{order_id}",
                                    data=params, headers=self.headers).json()["data"][
            "order_id"]
        return order_id

    def cancel_order(self, variety, order_id, parent_order_id=None):
        try:
            transact = self.session.delete(f"{self.root_url}/orders/{variety}/{order_id}",
                                       data={"parent_order_id": parent_order_id} if parent_order_id else {},
                                       headers=self.headers).json()
            order_id = transact["data"]["order_id"]
        except Exception:
            print("ERROR:",transact['message'])
            return transact["data"]
        return order_id

    def __convert_position(self, exchange, tradingsymbol, transaction_type, position_type, quantity, old_product, new_product):
        """This method is underconstruction and never tested"""
        params = locals()
        del params["self"]
        for k in list(params.keys()):
            if params[k] is None:
                del params[k]

        resp = self.session.put(f"{self.root_url}/portfolio/positions",
                                    data=params, headers=self.headers).json()["data"]
        return resp

    def tot_num_holdings(self):
        return len(self.holdings())

    def order_trades(self, order_id):
        """
        Retrieve the list of trades executed for a particular order.
        - `order_id` is the ID of the order to retrieve trade history.
        """
        data = self.session.get(f"{self.root_url}/orders/{order_id}/trades", headers=self.headers).json()["data"]
        return data

    def ohlc(self, *instruments):
        """
            Retrieve OHLC and market depth for list of instruments.
            - `instruments` is a list of instruments, Instrument are in the format of `exchange:tradingsymbol`. For example NSE:INFY
        """
        ins = list(instruments)
        #return self._get("market.quote.ohlc", params={"i": ins})
        #data = self.session.get(f"{self.root_url}/quote/ltp", params={"i": instruments}, headers=self.headers).json()["data"]
        return self.session.get(f"{self.root_url}/quote/ohlc", params={"i": ins}, headers=self.headers).json()["data"]



class Sim_KiteApp(KiteApp):
    def __init__(self,enctoken):
        super().__init__(enctoken=enctoken)

    def generate_orderid(self):
        num = random.randrange(1, 10 ** 8)
        #num_with_zeros = '{:03}'.format(num)
        num_with_zeros = str(num).zfill(8)
        return num_with_zeros

    def place_order(self, *args, **kwargs):
        print("Inside simulation place order")
        sym=args[2]
        t_type=args[3]
        t_quantity=args[4]
        prod=args[5]
        print(sym,t_type,t_quantity,prod)
        return {"status": "success", "order_id": self.generate_orderid()}


    def cancel_order(self,*args):
        order_id=args[1]
        print("Inside simulation cancle order")
        print('simulation order %s cancelled'%order_id)
        return order_id