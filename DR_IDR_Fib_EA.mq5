//+------------------------------------------------------------------+
//|  DR_IDR_Fib_EA.mq5                                               |
//|  DR/IDR deviation + fib retracement entry, stop at day extreme,  |
//|  fixed R:R target.                                               |
//|                                                                  |
//|  1. DR/IDR built from the 09:30-10:30 NY window (M5 bars).       |
//|  2. Deviation outside the range that closes back inside arms a   |
//|     setup (below = long, above = short).                         |
//|  3. Leg = deviation extreme -> furthest point reached after it.  |
//|     Enter when price retraces InpFibEntry (0.7-0.8) of the leg.  |
//|  4. SL beyond the day low (long) / day high (short).             |
//|  5. TP = InpRR x risk (default 1:3).                             |
//+------------------------------------------------------------------+
#property copyright "Cloudcove"
#property version   "2.00"
#property strict

#include <Trade/Trade.mqh>

enum ENUM_REF_LEVEL { REF_IDR = 0, REF_DR = 1 };
enum ENUM_LOT_MODE  { LOT_FIXED = 0, LOT_RISK_PERCENT = 1 };

input group "=== Session (all times HHMM, New York) ==="
input int            InpServerToNYHours = 7;      // Server time minus NY time, hours (NY-close brokers: 7)
input int            InpDRStart         = 930;    // DR window start
input int            InpDREnd           = 1030;   // DR window end (setups start after this)
input int            InpTradeEnd        = 1500;   // No new entries after
input int            InpCloseAll        = 1555;   // Flat all positions at

input group "=== Setup ==="
input ENUM_REF_LEVEL InpRefLevel        = REF_IDR; // Level that must be deviated
input bool           InpAllowWickDev    = true;    // Single bar wicks out and closes back inside = setup
input int            InpMaxDevBars      = 6;       // Max M5 bars allowed outside before setup is void
input int            InpMinRangePoints  = 0;       // Skip day if range smaller than (points), 0 = off
input int            InpMaxRangePoints  = 0;       // Skip day if range larger than (points), 0 = off
input int            InpMaxTradesPerDay = 1;

input group "=== Fib entry ==="
input double         InpFibEntry        = 0.75;    // Retracement of the leg to enter at (0.7 - 0.8 zone)
input double         InpMinLegFrac      = 0.5;     // Leg must be at least this fraction of the range height

input group "=== Exits ==="
input double         InpRR              = 3.0;     // Take profit = RR x risk (1:3)
input int            InpSLBufferPoints  = 20;      // Extra points beyond the day low/high
input int            InpMaxRiskPoints   = 0;       // Skip setup if stop distance larger than (points), 0 = off

input group "=== Money management ==="
input ENUM_LOT_MODE  InpLotMode         = LOT_RISK_PERCENT;
input double         InpFixedLot        = 0.10;
input double         InpRiskPercent     = 1.0;
input double         InpMaxRiskOverrun  = 0.0;     // Skip trade if min lot risks more than this x intended risk, 0 = off
input int            InpMaxSpreadPoints = 0;       // Skip entry if spread above (points), 0 = off

input group "=== Misc ==="
input long           InpMagic           = 88002;
input int            InpDeviationPoints = 30;      // Max slippage (points)
input bool           InpDebug           = true;    // Log why days/setups are skipped

CTrade  g_trade;
datetime g_lastBar   = 0;
long     g_nyDay     = -1;
bool     g_rangeOK   = false;
bool     g_dayDone   = false;
double   g_drH, g_drL, g_idrH, g_idrL;
double   g_dayH = -DBL_MAX, g_dayL = DBL_MAX;
int      g_tradesToday = 0;
int      g_devDir    = 0;     // +1 outside above, -1 outside below
double   g_devExtreme = 0.0;
int      g_devBars   = 0;
int      g_armed     = 0;     // +1 waiting to buy the retrace, -1 waiting to sell it
double   g_legStart  = 0.0;   // deviation extreme
double   g_legEnd    = 0.0;   // furthest point reached since

//--- HHMM -> minutes of day
int HM(const int hhmm) { return (hhmm / 100) * 60 + (hhmm % 100); }

//--- server time -> NY time
datetime ToNY(const datetime t) { return t - (datetime)(InpServerToNYHours * 3600); }
long     NYDay(const datetime t) { return (long)(ToNY(t) / 86400); }
int      NYMinute(const datetime t) { return (int)((ToNY(t) % 86400) / 60); }

void Dbg(const string s) { if(InpDebug) Print("[DRIDR] ", TimeToString(TimeCurrent(), TIME_DATE | TIME_MINUTES), " ", s); }

double RangeHeight() { return (InpRefLevel == REF_IDR) ? (g_idrH - g_idrL) : (g_drH - g_drL); }

//+------------------------------------------------------------------+
int OnInit()
  {
   if(HM(InpDRStart) >= HM(InpDREnd) || HM(InpDREnd) >= HM(InpTradeEnd) || HM(InpTradeEnd) > HM(InpCloseAll))
     {
      Print("Invalid session times.");
      return INIT_PARAMETERS_INCORRECT;
     }
   if(InpFibEntry < 0.5 || InpFibEntry > 0.95 || InpRR <= 0)
     {
      Print("Invalid fib / RR input.");
      return INIT_PARAMETERS_INCORRECT;
     }
   g_trade.SetExpertMagicNumber(InpMagic);
   g_trade.SetDeviationInPoints(InpDeviationPoints);
   g_trade.SetTypeFillingBySymbol(_Symbol);
   return INIT_SUCCEEDED;
  }

//+------------------------------------------------------------------+
bool HasPosition()
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong tk = PositionGetTicket(i);
      if(tk == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) == _Symbol && PositionGetInteger(POSITION_MAGIC) == InpMagic)
         return true;
     }
   return false;
  }

void CloseAll()
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong tk = PositionGetTicket(i);
      if(tk == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) == _Symbol && PositionGetInteger(POSITION_MAGIC) == InpMagic)
         g_trade.PositionClose(tk);
     }
  }

//+------------------------------------------------------------------+
//| Build DR / IDR and the day high/low so far from M5 bars           |
//+------------------------------------------------------------------+
bool BuildRange()
  {
   MqlRates r[];
   ArraySetAsSeries(r, false);
   int n = CopyRates(_Symbol, PERIOD_M5, 0, 600, r);
   if(n <= 1) return false;

   int s = HM(InpDRStart), e = HM(InpDREnd);
   double hi = -DBL_MAX, lo = DBL_MAX, bhi = -DBL_MAX, blo = DBL_MAX;
   int cnt = 0;
   for(int i = 0; i < n - 1; i++)           // n-1: skip the forming bar
     {
      if(NYDay(r[i].time) != g_nyDay) continue;
      g_dayH = MathMax(g_dayH, r[i].high);
      g_dayL = MathMin(g_dayL, r[i].low);
      int m = NYMinute(r[i].time);
      if(m < s || m >= e) continue;
      hi  = MathMax(hi,  r[i].high);
      lo  = MathMin(lo,  r[i].low);
      bhi = MathMax(bhi, MathMax(r[i].open, r[i].close));
      blo = MathMin(blo, MathMin(r[i].open, r[i].close));
      cnt++;
     }
   int expected = (e - s) / 5;
   if(cnt < (int)(expected * 0.8))                 // missing data / holiday / wrong time offset
     {
      Dbg("no valid window: found " + IntegerToString(cnt) + " M5 bars, need " + IntegerToString((int)(expected * 0.8)) +
          " (check InpServerToNYHours and M5 history)");
      return false;
     }

   g_drH = hi;  g_drL = lo;  g_idrH = bhi;  g_idrL = blo;
   Dbg("range built | IDR " + DoubleToString(g_idrL, _Digits) + "-" + DoubleToString(g_idrH, _Digits) +
       " | DR " + DoubleToString(g_drL, _Digits) + "-" + DoubleToString(g_drH, _Digits));
   return true;
  }

//+------------------------------------------------------------------+
double CalcLots(const ENUM_ORDER_TYPE type, const double entry, const double sl)
  {
   double minL = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxL = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   double lots = InpFixedLot;

   if(InpLotMode == LOT_RISK_PERCENT)
     {
      double profit = 0.0;
      if(!OrderCalcProfit(type, _Symbol, 1.0, entry, sl, profit) || profit == 0.0) return 0.0;
      double lossPerLot = MathAbs(profit);
      double riskMoney  = AccountInfoDouble(ACCOUNT_EQUITY) * InpRiskPercent / 100.0;
      lots = riskMoney / lossPerLot;
      if(lots < minL)
        {
         double pct = minL * lossPerLot / AccountInfoDouble(ACCOUNT_EQUITY) * 100.0;
         Dbg("min lot " + DoubleToString(minL, 2) + " risks " + DoubleToString(pct, 1) + "% of equity (wanted " +
             DoubleToString(InpRiskPercent, 1) + "%)");
         // minimum lot would risk far more than intended -> optionally skip instead of overrisking
         if(InpMaxRiskOverrun > 0 && minL * lossPerLot > riskMoney * InpMaxRiskOverrun) return 0.0;
        }
     }
   lots = MathFloor(lots / step) * step;
   lots = MathMax(minL, MathMin(maxL, lots));
   return NormalizeDouble(lots, 2);
  }

//+------------------------------------------------------------------+
void Enter(const int dir, const double slExtreme)
  {
   // dir = +1 buy, -1 sell. slExtreme = day low (buy) / day high (sell)
   double point  = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   int    digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);

   if(InpMaxSpreadPoints > 0 && (ask - bid) / point > InpMaxSpreadPoints) return;

   double entry = (dir > 0) ? ask : bid;
   double sl    = (dir > 0) ? slExtreme - InpSLBufferPoints * point
                            : slExtreme + InpSLBufferPoints * point;
   if((dir > 0 && sl >= entry) || (dir < 0 && sl <= entry))
     { Dbg("skip: stop on wrong side of entry"); g_armed = 0; return; }

   double risk = MathAbs(entry - sl);
   if(InpMaxRiskPoints > 0 && risk / point > InpMaxRiskPoints)
     { Dbg("skip: stop " + DoubleToString(risk / point, 0) + " points > InpMaxRiskPoints"); g_armed = 0; return; }

   double minDist = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * point;
   if(risk < minDist) { Dbg("skip: stop inside broker stop level"); g_armed = 0; return; }
   Dbg("entry trigger | stop distance " + DoubleToString(risk / point, 0) + " points, day extreme " +
       DoubleToString(slExtreme, digits));

   double tp = (dir > 0) ? entry + InpRR * risk : entry - InpRR * risk;

   sl = NormalizeDouble(sl, digits);
   tp = NormalizeDouble(tp, digits);

   ENUM_ORDER_TYPE type = (dir > 0) ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   double lots = CalcLots(type, entry, sl);
   if(lots <= 0) { Dbg("skip: lot size zero (risk guard or OrderCalcProfit failed)"); g_armed = 0; return; }

   bool ok = (dir > 0) ? g_trade.Buy (lots, _Symbol, 0.0, sl, tp, "DR/IDR fib")
                       : g_trade.Sell(lots, _Symbol, 0.0, sl, tp, "DR/IDR fib");
   if(ok)
     {
      g_tradesToday++;
      Print((dir > 0 ? "BUY " : "SELL "), DoubleToString(lots, 2), " lots | entry ", DoubleToString(entry, digits),
            " sl ", DoubleToString(sl, digits), " tp ", DoubleToString(tp, digits),
            " | leg ", DoubleToString(g_legStart, digits), "->", DoubleToString(g_legEnd, digits),
            " | IDR ", DoubleToString(g_idrL, digits), "-", DoubleToString(g_idrH, digits),
            " DR ", DoubleToString(g_drL, digits), "-", DoubleToString(g_drH, digits));
     }
   else
      Print("Order failed: ", g_trade.ResultRetcode(), " ", g_trade.ResultRetcodeDescription());
   g_armed = 0;
  }

//+------------------------------------------------------------------+
//| Tick-level: track the leg and wait for the fib retracement       |
//+------------------------------------------------------------------+
void CheckFibEntry(const int nyMin)
  {
   if(nyMin >= HM(InpTradeEnd) || g_tradesToday >= InpMaxTradesPerDay || HasPosition())
     {
      if(nyMin >= HM(InpTradeEnd))
         Dbg("setup expired unfilled | leg " + DoubleToString(MathAbs(g_legEnd - g_legStart) / _Point, 0) +
             " points, needed " + DoubleToString(InpMinLegFrac * RangeHeight() / _Point, 0));
      g_armed = 0;
      return;
     }

   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double minLeg = InpMinLegFrac * RangeHeight();

   if(g_armed == 1)                                   // long setup
     {
      if(bid < g_legStart) { g_legStart = bid; g_legEnd = bid; return; }   // new low: leg restarts
      g_legEnd = MathMax(g_legEnd, bid);
      double leg = g_legEnd - g_legStart;
      if(leg < minLeg) return;
      double level = g_legEnd - InpFibEntry * leg;
      if(ask <= level) Enter(1, MathMin(g_dayL, g_legStart));
     }
   else if(g_armed == -1)                             // short setup
     {
      if(ask > g_legStart) { g_legStart = ask; g_legEnd = ask; return; }   // new high: leg restarts
      g_legEnd = MathMin(g_legEnd, bid);
      double leg = g_legStart - g_legEnd;
      if(leg < minLeg) return;
      double level = g_legEnd + InpFibEntry * leg;
      if(bid >= level) Enter(-1, MathMax(g_dayH, g_legStart));
     }
  }

//+------------------------------------------------------------------+
void ResetDay(const long nyDay)
  {
   g_nyDay = nyDay;
   g_rangeOK = false;
   g_dayDone = false;
   g_tradesToday = 0;
   g_devDir = 0;
   g_devBars = 0;
   g_armed = 0;
   g_dayH = -DBL_MAX;
   g_dayL = DBL_MAX;
  }

//+------------------------------------------------------------------+
//| Once per new M5 bar: range, day extremes, deviation detection    |
//+------------------------------------------------------------------+
void OnNewBar(const int nyMin)
  {
   if(g_dayDone || nyMin < HM(InpDREnd)) return;

   if(!g_rangeOK)
     {
      if(!BuildRange()) { g_dayDone = true; return; }   // no valid window today
      double rangePts = RangeHeight() / _Point;
      if((InpMinRangePoints > 0 && rangePts < InpMinRangePoints) ||
         (InpMaxRangePoints > 0 && rangePts > InpMaxRangePoints))
        { g_dayDone = true; return; }
      g_rangeOK = true;
     }

   datetime t1 = iTime(_Symbol, PERIOD_M5, 1);
   if(NYDay(t1) != g_nyDay) return;

   double c1 = iClose(_Symbol, PERIOD_M5, 1);
   double h1 = iHigh (_Symbol, PERIOD_M5, 1);
   double l1 = iLow  (_Symbol, PERIOD_M5, 1);
   g_dayH = MathMax(g_dayH, h1);
   g_dayL = MathMin(g_dayL, l1);

   if(NYMinute(t1) < HM(InpDREnd)) return;                 // bar still inside the window
   if(g_armed != 0) return;                                // setup already waiting for its retrace
   if(nyMin >= HM(InpTradeEnd) || g_tradesToday >= InpMaxTradesPerDay || HasPosition()) return;

   double hi = (InpRefLevel == REF_IDR) ? g_idrH : g_drH;
   double lo = (InpRefLevel == REF_IDR) ? g_idrL : g_drL;

   if(g_devDir == 1)                                       // was outside above -> short setup
     {
      g_devExtreme = MathMax(g_devExtreme, h1);
      if(c1 <= hi)
        {
         g_armed = -1; g_legStart = g_devExtreme; g_legEnd = l1; g_devDir = 0;
         Dbg("SHORT setup armed | deviation high " + DoubleToString(g_legStart, _Digits));
         return;
        }
      if(++g_devBars > InpMaxDevBars) g_devDir = 0;        // acceptance -> real breakout
      return;
     }
   if(g_devDir == -1)                                      // was outside below -> long setup
     {
      g_devExtreme = MathMin(g_devExtreme, l1);
      if(c1 >= lo)
        {
         g_armed = 1; g_legStart = g_devExtreme; g_legEnd = h1; g_devDir = 0;
         Dbg("LONG setup armed | deviation low " + DoubleToString(g_legStart, _Digits));
         return;
        }
      if(++g_devBars > InpMaxDevBars) g_devDir = 0;
      return;
     }

   if(c1 > hi)       { g_devDir = 1;  g_devExtreme = h1; g_devBars = 1; }
   else if(c1 < lo)  { g_devDir = -1; g_devExtreme = l1; g_devBars = 1; }
   else if(InpAllowWickDev)
     {
      if(h1 > hi)      { g_armed = -1; g_legStart = h1; g_legEnd = l1; Dbg("SHORT setup armed (wick)"); }
      else if(l1 < lo) { g_armed = 1;  g_legStart = l1; g_legEnd = h1; Dbg("LONG setup armed (wick)"); }
     }
  }

//+------------------------------------------------------------------+
void OnTick()
  {
   datetime now = TimeCurrent();
   if(NYDay(now) != g_nyDay) ResetDay(NYDay(now));
   int nyMin = NYMinute(now);

   if(nyMin >= HM(InpCloseAll))
     {
      g_armed = 0;
      if(HasPosition()) CloseAll();
      return;
     }

   datetime barTime = iTime(_Symbol, PERIOD_M5, 0);
   if(barTime != g_lastBar)
     {
      g_lastBar = barTime;
      OnNewBar(nyMin);
     }

   if(g_armed != 0) CheckFibEntry(nyMin);
  }
//+------------------------------------------------------------------+
