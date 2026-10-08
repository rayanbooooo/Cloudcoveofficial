//+------------------------------------------------------------------+
//|  DR_IDR_EA.mq5                                                   |
//|  Defining Range / Implied Defining Range deviation (fade) EA     |
//|                                                                  |
//|  DR  = high/low (wicks) of the 09:30-10:30 NY window             |
//|  IDR = high/low of candle BODIES (open/close) in the same window |
//|                                                                  |
//|  Logic: after the window closes, price pushes outside the range  |
//|  (deviation) and then closes back inside -> trade back into it.  |
//|  Run on any chart, the EA reads M5 bars internally.              |
//+------------------------------------------------------------------+
#property copyright "Cloudcove"
#property version   "1.00"
#property strict

#include <Trade/Trade.mqh>

enum ENUM_REF_LEVEL { REF_IDR = 0, REF_DR = 1 };
enum ENUM_TP_MODE   { TP_MIDPOINT = 0, TP_OPPOSITE = 1, TP_FIXED_RR = 2 };
enum ENUM_LOT_MODE  { LOT_FIXED = 0, LOT_RISK_PERCENT = 1 };

input group "=== Session (all times HHMM, New York) ==="
input int            InpServerToNYHours = 7;      // Server time minus NY time, hours (NY-close brokers: 7)
input int            InpDRStart         = 930;    // DR window start
input int            InpDREnd           = 1030;   // DR window end (trading starts after this)
input int            InpTradeEnd        = 1500;   // No new entries after
input int            InpCloseAll        = 1555;   // Flat all positions at

input group "=== Setup ==="
input ENUM_REF_LEVEL InpRefLevel        = REF_IDR; // Level that must be deviated
input bool           InpAllowWickDev    = true;    // Single bar wicks out and closes back inside = signal
input int            InpMaxDevBars      = 6;       // Max M5 bars allowed outside before signal is void
input int            InpMinRangePoints  = 0;       // Skip day if range smaller than (points), 0 = off
input int            InpMaxRangePoints  = 0;       // Skip day if range larger than (points), 0 = off
input int            InpMaxTradesPerDay = 1;

input group "=== Exits ==="
input ENUM_TP_MODE   InpTPMode          = TP_MIDPOINT; // Take profit target
input double         InpFixedRR         = 1.5;         // R multiple (TP_FIXED_RR)
input int            InpSLBufferPoints  = 20;          // Extra points beyond deviation extreme
input double         InpMinRR           = 0.0;         // Skip trade if reward/risk below this, 0 = off

input group "=== Money management ==="
input ENUM_LOT_MODE  InpLotMode         = LOT_RISK_PERCENT;
input double         InpFixedLot        = 0.10;
input double         InpRiskPercent     = 1.0;
input int            InpMaxSpreadPoints = 0;           // Skip entry if spread above (points), 0 = off

input group "=== Misc ==="
input long           InpMagic           = 88001;
input int            InpDeviationPoints = 30;          // Max slippage (points)

CTrade   g_trade;
datetime g_lastBar   = 0;
long     g_nyDay     = -1;
bool     g_rangeOK   = false;
bool     g_dayDone   = false;
double   g_drH, g_drL, g_idrH, g_idrL;
int      g_tradesToday = 0;
int      g_devDir    = 0;     // +1 outside above, -1 outside below
double   g_devExtreme = 0.0;
int      g_devBars   = 0;

//--- HHMM -> minutes of day
int HM(const int hhmm) { return (hhmm / 100) * 60 + (hhmm % 100); }

//--- server time -> NY time
datetime ToNY(const datetime t) { return t - (datetime)(InpServerToNYHours * 3600); }
long     NYDay(const datetime t) { return (long)(ToNY(t) / 86400); }
int      NYMinute(const datetime t) { return (int)((ToNY(t) % 86400) / 60); }

//+------------------------------------------------------------------+
int OnInit()
  {
   if(HM(InpDRStart) >= HM(InpDREnd) || HM(InpDREnd) >= HM(InpTradeEnd) || HM(InpTradeEnd) > HM(InpCloseAll))
     {
      Print("Invalid session times.");
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
//| Build DR / IDR for the current NY day from M5 bars                |
//+------------------------------------------------------------------+
bool BuildRange()
  {
   MqlRates r[];
   ArraySetAsSeries(r, false);
   int n = CopyRates(_Symbol, PERIOD_M5, 0, 600, r);
   if(n <= 0) return false;

   int s = HM(InpDRStart), e = HM(InpDREnd);
   double hi = -DBL_MAX, lo = DBL_MAX, bhi = -DBL_MAX, blo = DBL_MAX;
   int cnt = 0;
   for(int i = 0; i < n; i++)
     {
      if(NYDay(r[i].time) != g_nyDay) continue;
      int m = NYMinute(r[i].time);
      if(m < s || m >= e) continue;
      hi  = MathMax(hi,  r[i].high);
      lo  = MathMin(lo,  r[i].low);
      bhi = MathMax(bhi, MathMax(r[i].open, r[i].close));
      blo = MathMin(blo, MathMin(r[i].open, r[i].close));
      cnt++;
     }
   int expected = (e - s) / 5;
   if(cnt < (int)(expected * 0.8)) return false;   // missing data / holiday

   g_drH = hi;  g_drL = lo;  g_idrH = bhi;  g_idrL = blo;
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
      double riskMoney = AccountInfoDouble(ACCOUNT_EQUITY) * InpRiskPercent / 100.0;
      lots = riskMoney / MathAbs(profit);
     }
   lots = MathFloor(lots / step) * step;
   lots = MathMax(minL, MathMin(maxL, lots));
   return NormalizeDouble(lots, 2);
  }

//+------------------------------------------------------------------+
void TryEnter(const int dir, const double extreme)
  {
   // dir = -1: price deviated ABOVE and came back -> SELL
   // dir = +1: price deviated BELOW and came back -> BUY
   double point = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   int    digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);

   if(InpMaxSpreadPoints > 0 && (ask - bid) / point > InpMaxSpreadPoints) return;

   double hi  = (InpRefLevel == REF_IDR) ? g_idrH : g_drH;
   double lo  = (InpRefLevel == REF_IDR) ? g_idrL : g_drL;
   double mid = (hi + lo) / 2.0;

   double entry = (dir < 0) ? bid : ask;
   double sl    = (dir < 0) ? extreme + InpSLBufferPoints * point
                            : extreme - InpSLBufferPoints * point;
   double risk  = MathAbs(entry - sl);
   if(risk <= 0) return;

   double tp;
   switch(InpTPMode)
     {
      case TP_MIDPOINT : tp = mid; break;
      case TP_OPPOSITE : tp = (dir < 0) ? lo : hi; break;
      default          : tp = (dir < 0) ? entry - InpFixedRR * risk : entry + InpFixedRR * risk; break;
     }

   // TP must be on the profit side of entry
   if((dir < 0 && tp >= entry) || (dir > 0 && tp <= entry)) return;
   double reward = MathAbs(entry - tp);
   if(InpMinRR > 0 && reward / risk < InpMinRR) return;

   // broker minimum stop distance
   double minDist = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * point;
   if(risk < minDist || reward < minDist) return;

   sl = NormalizeDouble(sl, digits);
   tp = NormalizeDouble(tp, digits);

   ENUM_ORDER_TYPE type = (dir < 0) ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
   double lots = CalcLots(type, entry, sl);
   if(lots <= 0) return;

   bool ok = (dir < 0) ? g_trade.Sell(lots, _Symbol, 0.0, sl, tp, "DR/IDR fade")
                       : g_trade.Buy (lots, _Symbol, 0.0, sl, tp, "DR/IDR fade");
   if(ok)
     {
      g_tradesToday++;
      g_devDir = 0;
      Print((dir < 0 ? "SELL " : "BUY "), DoubleToString(lots, 2), " lots | entry ", DoubleToString(entry, digits),
            " sl ", DoubleToString(sl, digits), " tp ", DoubleToString(tp, digits),
            " | IDR ", DoubleToString(g_idrL, digits), "-", DoubleToString(g_idrH, digits),
            " DR ", DoubleToString(g_drL, digits), "-", DoubleToString(g_drH, digits));
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
  }

//+------------------------------------------------------------------+
void OnTick()
  {
   datetime barTime = iTime(_Symbol, PERIOD_M5, 0);
   if(barTime == g_lastBar) return;      // act once per new M5 bar
   g_lastBar = barTime;

   datetime now = TimeCurrent();
   if(NYDay(now) != g_nyDay) ResetDay(NYDay(now));

   int nyMin = NYMinute(now);

   if(nyMin >= HM(InpCloseAll))
     {
      CloseAll();
      return;
     }

   if(g_dayDone || nyMin < HM(InpDREnd)) return;

   if(!g_rangeOK)
     {
      if(!BuildRange()) { g_dayDone = true; return; }   // no valid window today
      double rangePts = ((InpRefLevel == REF_IDR ? g_idrH - g_idrL : g_drH - g_drL)) / _Point;
      if((InpMinRangePoints > 0 && rangePts < InpMinRangePoints) ||
         (InpMaxRangePoints > 0 && rangePts > InpMaxRangePoints))
        { g_dayDone = true; return; }
      g_rangeOK = true;
     }

   if(nyMin >= HM(InpTradeEnd) || g_tradesToday >= InpMaxTradesPerDay || HasPosition()) return;

   // last fully closed M5 bar must have opened at/after window end
   datetime t1 = iTime(_Symbol, PERIOD_M5, 1);
   if(NYDay(t1) != g_nyDay || NYMinute(t1) < HM(InpDREnd)) return;

   double c1 = iClose(_Symbol, PERIOD_M5, 1);
   double h1 = iHigh (_Symbol, PERIOD_M5, 1);
   double l1 = iLow  (_Symbol, PERIOD_M5, 1);
   double hi = (InpRefLevel == REF_IDR) ? g_idrH : g_drH;
   double lo = (InpRefLevel == REF_IDR) ? g_idrL : g_drL;

   // already outside: waiting for close back inside
   if(g_devDir == 1)
     {
      g_devExtreme = MathMax(g_devExtreme, h1);
      if(c1 <= hi) { TryEnter(-1, g_devExtreme); g_devDir = 0; return; }
      if(++g_devBars > InpMaxDevBars) g_devDir = 0;      // acceptance -> not a deviation
      return;
     }
   if(g_devDir == -1)
     {
      g_devExtreme = MathMin(g_devExtreme, l1);
      if(c1 >= lo) { TryEnter(1, g_devExtreme); g_devDir = 0; return; }
      if(++g_devBars > InpMaxDevBars) g_devDir = 0;
      return;
     }

   // fresh evaluation
   if(c1 > hi)       { g_devDir = 1;  g_devExtreme = h1; g_devBars = 1; }
   else if(c1 < lo)  { g_devDir = -1; g_devExtreme = l1; g_devBars = 1; }
   else if(InpAllowWickDev)
     {
      if(h1 > hi)      TryEnter(-1, h1);
      else if(l1 < lo) TryEnter(1, l1);
     }
  }
//+------------------------------------------------------------------+
