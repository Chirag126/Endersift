//! Endersift spending guard.
//!
//! The contract holds the agent's budget. The agent never holds a key that can
//! move NEAR: it signs `pay` with a function-call access key that is scoped to
//! this contract, and the contract decides. A payment goes out only when
//!
//!   - the contract is not paused,
//!   - the caller is the agent account,
//!   - the receiver is a registered provider and is not on the blocklist,
//!   - the amount is inside the per-payment, per-run and per-day caps, and
//!   - the run has not used up its number of payments.
//!
//! Every payment that goes out leaves a receipt. A refused call panics with one
//! of the `ERR_*` codes, so the failed transaction and its reason stay visible
//! on the explorer.
//!
//! Amounts are yoctoNEAR (1 NEAR = 10^24) and travel as decimal strings in JSON.

use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{
    env, is_promise_success, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise,
};

const NS_PER_DAY: u64 = 86_400_000_000_000;
const CALLBACK_GAS: Gas = Gas::from_tgas(10);

/// Text limits: on-chain metadata is public and paid for by the contract.
const MAX_LABEL: usize = 32;
const MAX_ENDPOINT: usize = 256;
const MAX_TEXT: usize = 512;
const MAX_RUN_ID: usize = 64;
const MAX_REPORTS_PER_ACCOUNT: usize = 20;
const MAX_PAGE: u32 = 50;

pub const ERR_PAUSED: &str = "ERR_PAUSED";
pub const ERR_NOT_OWNER: &str = "ERR_NOT_OWNER";
pub const ERR_NOT_AGENT: &str = "ERR_NOT_AGENT";
pub const ERR_NOT_REPORTER: &str = "ERR_NOT_REPORTER";
pub const ERR_NOT_REGISTERED: &str = "ERR_NOT_REGISTERED";
pub const ERR_BLOCKED: &str = "ERR_BLOCKED";
pub const ERR_ZERO_AMOUNT: &str = "ERR_ZERO_AMOUNT";
pub const ERR_OVER_PAYMENT_CAP: &str = "ERR_OVER_PAYMENT_CAP";
pub const ERR_OVER_RUN_CAP: &str = "ERR_OVER_RUN_CAP";
pub const ERR_OVER_DAY_CAP: &str = "ERR_OVER_DAY_CAP";
pub const ERR_TOO_MANY_PAYMENTS: &str = "ERR_TOO_MANY_PAYMENTS";
pub const ERR_ABOVE_PRICE: &str = "ERR_ABOVE_PRICE";
pub const ERR_BAD_INPUT: &str = "ERR_BAD_INPUT";
pub const ERR_NO_RECEIPT: &str = "ERR_NO_RECEIPT";
pub const ERR_ALREADY_ATTESTED: &str = "ERR_ALREADY_ATTESTED";

/// The caps the owner sets. The agent cannot change them.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Policy {
    pub max_per_payment: NearToken,
    pub max_per_run: NearToken,
    pub max_per_day: NearToken,
    pub max_payments_per_run: u32,
}

/// A data seller the agent may pay. The account id is the map key.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Provider {
    pub label: String,
    pub endpoint: String,
    pub description: String,
    /// The most one request may cost. `pay` refuses a larger amount.
    pub price: NearToken,
    /// The receiver's contract code hash when it was registered ("" = no contract).
    /// The agent-side check compares it with the current hash.
    pub code_hash: String,
    pub registered_at_ms: u64,
}

/// One blocklist report, with the evidence the reporter attached.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Report {
    pub reporter: AccountId,
    pub reason: String,
    pub evidence: String,
    pub at_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum ReceiptStatus {
    /// The transfer was sent; its result has not come back yet.
    Pending,
    Paid,
    /// The transfer failed; the amount was returned to the caps.
    Failed,
}

/// What was bought, from whom, at what price, and whether the work passed.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Receipt {
    pub id: u32,
    pub run_id: String,
    pub receiver: AccountId,
    pub amount: NearToken,
    pub memo: String,
    pub status: ReceiptStatus,
    /// The agent's check of the delivered work: None until it attests.
    pub passed: Option<bool>,
    pub at_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RunSpend {
    pub spent: NearToken,
    pub payments: u32,
}

/// The agent's history with one receiver, read by the counterparty check.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ReceiverStats {
    pub payments: u32,
    pub total: NearToken,
    pub passed: u32,
    pub failed: u32,
    pub first_paid_at_ms: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ProviderView {
    pub account_id: AccountId,
    pub provider: Provider,
    pub blocked: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Status {
    pub owner: AccountId,
    pub agent: AccountId,
    pub paused: bool,
    pub policy: Policy,
    pub day: u64,
    pub spent_today: NearToken,
    pub balance: NearToken,
    pub providers: u32,
    pub receipts: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Guard {
    owner: AccountId,
    agent: AccountId,
    paused: bool,
    policy: Policy,
    providers: IterableMap<AccountId, Provider>,
    reporters: LookupMap<AccountId, bool>,
    reports: LookupMap<AccountId, Vec<Report>>,
    runs: LookupMap<String, RunSpend>,
    stats: LookupMap<AccountId, ReceiverStats>,
    receipts: Vector<Receipt>,
    day: u64,
    spent_today: NearToken,
}

fn now_ms() -> u64 {
    env::block_timestamp() / 1_000_000
}

fn today() -> u64 {
    env::block_timestamp() / NS_PER_DAY
}

fn check_policy(policy: &Policy) {
    require!(policy.max_per_payment.as_yoctonear() > 0, ERR_BAD_INPUT);
    require!(policy.max_per_payment <= policy.max_per_run, ERR_BAD_INPUT);
    require!(policy.max_per_run <= policy.max_per_day, ERR_BAD_INPUT);
    require!(policy.max_payments_per_run > 0, ERR_BAD_INPUT);
}

fn event(name: &str, data: String) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"endersift-guard\",\"version\":\"1.0.0\",\"event\":\"{name}\",\"data\":{data}}}"
    ));
}

#[near]
impl Guard {
    #[init]
    pub fn new(owner: AccountId, agent: AccountId, policy: Policy) -> Self {
        check_policy(&policy);
        let mut reporters = LookupMap::new(b"r".to_vec());
        reporters.insert(owner.clone(), true);
        reporters.insert(agent.clone(), true);
        Self {
            owner,
            agent,
            paused: false,
            policy,
            providers: IterableMap::new(b"p".to_vec()),
            reporters,
            reports: LookupMap::new(b"b".to_vec()),
            runs: LookupMap::new(b"u".to_vec()),
            stats: LookupMap::new(b"s".to_vec()),
            receipts: Vector::new(b"c".to_vec()),
            day: 0,
            spent_today: NearToken::from_yoctonear(0),
        }
    }

    // ---- owner ----

    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, ERR_NOT_OWNER);
    }

    pub fn set_policy(&mut self, policy: Policy) {
        self.only_owner();
        check_policy(&policy);
        self.policy = policy;
        event("policy_set", "{}".to_string());
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.only_owner();
        self.paused = paused;
        event("paused_set", format!("{{\"paused\":{paused}}}"));
    }

    pub fn set_agent(&mut self, agent: AccountId) {
        self.only_owner();
        self.reporters.insert(agent.clone(), true);
        self.agent = agent;
    }

    pub fn set_reporter(&mut self, account_id: AccountId, allowed: bool) {
        self.only_owner();
        self.reporters.insert(account_id, allowed);
    }

    /// Add or replace a provider. Only the owner decides who can be paid.
    pub fn register_provider(
        &mut self,
        account_id: AccountId,
        label: String,
        endpoint: String,
        description: String,
        price: NearToken,
        code_hash: String,
    ) {
        self.only_owner();
        require!(!label.is_empty() && label.len() <= MAX_LABEL, ERR_BAD_INPUT);
        require!(
            !endpoint.is_empty() && endpoint.len() <= MAX_ENDPOINT,
            ERR_BAD_INPUT
        );
        require!(description.len() <= MAX_TEXT, ERR_BAD_INPUT);
        require!(code_hash.len() <= 64, ERR_BAD_INPUT);
        require!(price.as_yoctonear() > 0, ERR_BAD_INPUT);
        let registered_at_ms = match self.providers.get(&account_id) {
            Some(existing) => existing.registered_at_ms,
            None => now_ms(),
        };
        self.providers.insert(
            account_id.clone(),
            Provider {
                label,
                endpoint,
                description,
                price,
                code_hash,
                registered_at_ms,
            },
        );
        event(
            "provider_registered",
            format!("{{\"account_id\":\"{account_id}\"}}"),
        );
    }

    pub fn remove_provider(&mut self, account_id: AccountId) {
        self.only_owner();
        self.providers.remove(&account_id);
        event(
            "provider_removed",
            format!("{{\"account_id\":\"{account_id}\"}}"),
        );
    }

    /// Clear an account's reports (the owner judged them wrong).
    pub fn unblock(&mut self, account_id: AccountId) {
        self.only_owner();
        self.reports.remove(&account_id);
        event("unblocked", format!("{{\"account_id\":\"{account_id}\"}}"));
    }

    /// Take funds back out. The agent has no way to call this.
    pub fn withdraw(&mut self, amount: NearToken) -> Promise {
        self.only_owner();
        Promise::new(self.owner.clone()).transfer(amount)
    }

    /// Fund the guard. A plain transfer to the contract account works too.
    #[payable]
    pub fn deposit(&mut self) {
        event(
            "deposit",
            format!(
                "{{\"from\":\"{}\",\"amount\":\"{}\"}}",
                env::predecessor_account_id(),
                env::attached_deposit().as_yoctonear()
            ),
        );
    }

    // ---- blocklist ----

    /// Report an account with evidence. One report blocks it until the owner clears it.
    pub fn report(&mut self, account_id: AccountId, reason: String, evidence: String) {
        let reporter = env::predecessor_account_id();
        require!(
            self.reporters.get(&reporter).copied().unwrap_or(false),
            ERR_NOT_REPORTER
        );
        require!(
            !reason.is_empty() && reason.len() <= MAX_TEXT,
            ERR_BAD_INPUT
        );
        require!(evidence.len() <= MAX_TEXT, ERR_BAD_INPUT);
        let mut list = self.reports.get(&account_id).cloned().unwrap_or_default();
        require!(list.len() < MAX_REPORTS_PER_ACCOUNT, ERR_BAD_INPUT);
        list.push(Report {
            reporter: reporter.clone(),
            reason,
            evidence,
            at_ms: now_ms(),
        });
        self.reports.insert(account_id.clone(), list);
        event(
            "reported",
            format!("{{\"account_id\":\"{account_id}\",\"reporter\":\"{reporter}\"}}"),
        );
    }

    // ---- agent ----

    /// Pay a provider for one request. Called with the agent's function-call key:
    /// no deposit is attached, the NEAR comes from the guard's own balance.
    pub fn pay(
        &mut self,
        run_id: String,
        receiver: AccountId,
        amount: NearToken,
        memo: String,
    ) -> Promise {
        require!(!self.paused, ERR_PAUSED);
        require!(env::predecessor_account_id() == self.agent, ERR_NOT_AGENT);
        require!(
            !run_id.is_empty() && run_id.len() <= MAX_RUN_ID,
            ERR_BAD_INPUT
        );
        require!(memo.len() <= MAX_TEXT, ERR_BAD_INPUT);
        require!(amount.as_yoctonear() > 0, ERR_ZERO_AMOUNT);
        require!(!self.is_blocked(receiver.clone()), ERR_BLOCKED);
        let price = match self.providers.get(&receiver) {
            Some(provider) => provider.price,
            None => env::panic_str(ERR_NOT_REGISTERED),
        };
        require!(amount <= price, ERR_ABOVE_PRICE);
        require!(amount <= self.policy.max_per_payment, ERR_OVER_PAYMENT_CAP);

        let mut run = self.runs.get(&run_id).cloned().unwrap_or_default();
        require!(
            run.payments < self.policy.max_payments_per_run,
            ERR_TOO_MANY_PAYMENTS
        );
        let run_spent = run.spent.saturating_add(amount);
        require!(run_spent <= self.policy.max_per_run, ERR_OVER_RUN_CAP);

        let day = today();
        if day != self.day {
            self.day = day;
            self.spent_today = NearToken::from_yoctonear(0);
        }
        let day_spent = self.spent_today.saturating_add(amount);
        require!(day_spent <= self.policy.max_per_day, ERR_OVER_DAY_CAP);

        run.spent = run_spent;
        run.payments += 1;
        self.runs.insert(run_id.clone(), run);
        self.spent_today = day_spent;

        let id = self.receipts.len();
        self.receipts.push(Receipt {
            id,
            run_id: run_id.clone(),
            receiver: receiver.clone(),
            amount,
            memo,
            status: ReceiptStatus::Pending,
            passed: None,
            at_ms: now_ms(),
        });
        event(
            "payment_sent",
            format!(
                "{{\"receipt_id\":{id},\"run_id\":\"{run_id}\",\"receiver\":\"{receiver}\",\"amount\":\"{}\"}}",
                amount.as_yoctonear()
            ),
        );
        Promise::new(receiver).transfer(amount).then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_paid(id),
        )
    }

    /// Settles a receipt once the transfer's result is known. Returns the receipt id.
    #[private]
    pub fn on_paid(&mut self, receipt_id: u32) -> u32 {
        let ok = is_promise_success();
        self.settle(receipt_id, ok);
        receipt_id
    }

    /// Record whether the delivered work passed the agent's check.
    pub fn attest(&mut self, receipt_id: u32, passed: bool) {
        require!(env::predecessor_account_id() == self.agent, ERR_NOT_AGENT);
        let mut receipt = match self.receipts.get(receipt_id) {
            Some(receipt) => receipt.clone(),
            None => env::panic_str(ERR_NO_RECEIPT),
        };
        require!(receipt.passed.is_none(), ERR_ALREADY_ATTESTED);
        receipt.passed = Some(passed);
        let mut stats = self
            .stats
            .get(&receipt.receiver)
            .cloned()
            .unwrap_or_default();
        if passed {
            stats.passed += 1;
        } else {
            stats.failed += 1;
        }
        self.stats.insert(receipt.receiver.clone(), stats);
        self.receipts.replace(receipt_id, receipt);
        event(
            "attested",
            format!("{{\"receipt_id\":{receipt_id},\"passed\":{passed}}}"),
        );
    }

    // ---- views ----

    pub fn get_status(&self) -> Status {
        let fresh = today() == self.day;
        Status {
            owner: self.owner.clone(),
            agent: self.agent.clone(),
            paused: self.paused,
            policy: self.policy.clone(),
            day: today(),
            spent_today: if fresh {
                self.spent_today
            } else {
                NearToken::from_yoctonear(0)
            },
            balance: env::account_balance(),
            providers: self.providers.len(),
            receipts: self.receipts.len(),
        }
    }

    pub fn get_providers(&self) -> Vec<ProviderView> {
        self.providers
            .iter()
            .map(|(account_id, provider)| ProviderView {
                account_id: account_id.clone(),
                provider: provider.clone(),
                blocked: self.is_blocked(account_id.clone()),
            })
            .collect()
    }

    pub fn get_provider(&self, account_id: AccountId) -> Option<Provider> {
        self.providers.get(&account_id).cloned()
    }

    pub fn is_blocked(&self, account_id: AccountId) -> bool {
        match self.reports.get(&account_id) {
            Some(list) => !list.is_empty(),
            None => false,
        }
    }

    pub fn get_reports(&self, account_id: AccountId) -> Vec<Report> {
        self.reports.get(&account_id).cloned().unwrap_or_default()
    }

    pub fn get_run(&self, run_id: String) -> RunSpend {
        self.runs.get(&run_id).cloned().unwrap_or_default()
    }

    pub fn get_receiver_stats(&self, account_id: AccountId) -> ReceiverStats {
        self.stats.get(&account_id).cloned().unwrap_or_default()
    }

    pub fn get_receipt(&self, receipt_id: u32) -> Option<Receipt> {
        self.receipts.get(receipt_id).cloned()
    }

    /// Receipts from `from` (oldest first), at most `limit` (capped at 50).
    pub fn get_receipts(&self, from: u32, limit: u32) -> Vec<Receipt> {
        let end = from
            .saturating_add(limit.min(MAX_PAGE))
            .min(self.receipts.len());
        (from..end)
            .filter_map(|i| self.receipts.get(i).cloned())
            .collect()
    }
}

impl Guard {
    /// Close a pending receipt. A failed transfer gives the amount back to the caps.
    fn settle(&mut self, receipt_id: u32, ok: bool) {
        let mut receipt = match self.receipts.get(receipt_id) {
            Some(receipt) => receipt.clone(),
            None => env::panic_str(ERR_NO_RECEIPT),
        };
        if receipt.status != ReceiptStatus::Pending {
            return;
        }
        if ok {
            receipt.status = ReceiptStatus::Paid;
            let mut stats = self
                .stats
                .get(&receipt.receiver)
                .cloned()
                .unwrap_or_default();
            if stats.payments == 0 {
                stats.first_paid_at_ms = receipt.at_ms;
            }
            stats.payments += 1;
            stats.total = stats.total.saturating_add(receipt.amount);
            self.stats.insert(receipt.receiver.clone(), stats);
        } else {
            receipt.status = ReceiptStatus::Failed;
            let mut run = self.runs.get(&receipt.run_id).cloned().unwrap_or_default();
            run.spent = run.spent.saturating_sub(receipt.amount);
            run.payments = run.payments.saturating_sub(1);
            self.runs.insert(receipt.run_id.clone(), run);
            if receipt.at_ms / 86_400_000 == self.day {
                self.spent_today = self.spent_today.saturating_sub(receipt.amount);
            }
        }
        event(
            if ok {
                "payment_settled"
            } else {
                "payment_failed"
            },
            format!("{{\"receipt_id\":{receipt_id}}}"),
        );
        self.receipts.replace(receipt_id, receipt);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const DAY_NS: u64 = NS_PER_DAY;

    fn acct(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    fn milli(n: u128) -> NearToken {
        NearToken::from_millinear(n)
    }

    fn at(caller: &str, timestamp_ns: u64) {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(acct("guard.test"))
            .predecessor_account_id(acct(caller))
            .signer_account_id(acct(caller))
            .account_balance(NearToken::from_near(10))
            .block_timestamp(timestamp_ns);
        testing_env!(builder.build());
    }

    fn policy() -> Policy {
        Policy {
            max_per_payment: milli(10),
            max_per_run: milli(25),
            max_per_day: milli(40),
            max_payments_per_run: 3,
        }
    }

    /// A guard with one provider ("kev.test", price 10 mNEAR), at day 100.
    fn guard() -> Guard {
        at("owner.test", 100 * DAY_NS);
        let mut guard = Guard::new(acct("owner.test"), acct("agent.test"), policy());
        guard.register_provider(
            acct("kev.test"),
            "kev".to_string(),
            "https://example.test/v1/kev".to_string(),
            "Known exploited vulnerabilities".to_string(),
            milli(10),
            String::new(),
        );
        guard
    }

    fn pay(guard: &mut Guard, run: &str, receiver: &str, amount: NearToken) -> u32 {
        let id = guard.receipts.len();
        let _ = guard.pay(run.to_string(), acct(receiver), amount, "test".to_string());
        id
    }

    #[test]
    fn a_payment_inside_the_caps_leaves_a_receipt() {
        let mut guard = guard();
        at("agent.test", 100 * DAY_NS);
        let id = pay(&mut guard, "run-1", "kev.test", milli(5));
        let receipt = guard.get_receipt(id).unwrap();
        assert_eq!(receipt.status, ReceiptStatus::Pending);
        assert_eq!(receipt.amount, milli(5));
        assert_eq!(receipt.receiver, acct("kev.test"));
        assert_eq!(guard.get_run("run-1".to_string()).payments, 1);
        assert_eq!(guard.get_status().spent_today, milli(5));

        guard.settle(id, true);
        assert_eq!(guard.get_receipt(id).unwrap().status, ReceiptStatus::Paid);
        let stats = guard.get_receiver_stats(acct("kev.test"));
        assert_eq!(stats.payments, 1);
        assert_eq!(stats.total, milli(5));
    }

    #[test]
    fn a_failed_transfer_gives_the_amount_back_to_the_caps() {
        let mut guard = guard();
        at("agent.test", 100 * DAY_NS);
        let id = pay(&mut guard, "run-1", "kev.test", milli(5));
        guard.settle(id, false);
        assert_eq!(guard.get_receipt(id).unwrap().status, ReceiptStatus::Failed);
        assert_eq!(guard.get_run("run-1".to_string()), RunSpend::default());
        assert_eq!(guard.get_status().spent_today, NearToken::from_yoctonear(0));
        assert_eq!(guard.get_receiver_stats(acct("kev.test")).payments, 0);
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_AGENT")]
    fn only_the_agent_can_pay() {
        let mut guard = guard();
        at("mallory.test", 100 * DAY_NS);
        pay(&mut guard, "run-1", "kev.test", milli(1));
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_REGISTERED")]
    fn an_unregistered_receiver_is_refused() {
        let mut guard = guard();
        at("agent.test", 100 * DAY_NS);
        pay(&mut guard, "run-1", "evil.test", milli(1));
    }

    #[test]
    #[should_panic(expected = "ERR_BLOCKED")]
    fn a_reported_receiver_is_refused_even_when_registered() {
        let mut guard = guard();
        at("agent.test", 100 * DAY_NS);
        guard.report(
            acct("kev.test"),
            "served forged data".to_string(),
            "run-0 receipt 7".to_string(),
        );
        assert!(guard.is_blocked(acct("kev.test")));
        pay(&mut guard, "run-1", "kev.test", milli(1));
    }

    #[test]
    fn the_owner_can_clear_a_report() {
        let mut guard = guard();
        at("agent.test", 100 * DAY_NS);
        guard.report(acct("kev.test"), "mistake".to_string(), String::new());
        at("owner.test", 100 * DAY_NS);
        guard.unblock(acct("kev.test"));
        assert!(!guard.is_blocked(acct("kev.test")));
        assert!(guard.get_reports(acct("kev.test")).is_empty());
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_REPORTER")]
    fn a_stranger_cannot_report() {
        let mut guard = guard();
        at("mallory.test", 100 * DAY_NS);
        guard.report(acct("kev.test"), "spam".to_string(), String::new());
    }

    #[test]
    #[should_panic(expected = "ERR_ABOVE_PRICE")]
    fn an_amount_above_the_registered_price_is_refused() {
        let mut guard = guard();
        at("owner.test", 100 * DAY_NS);
        guard.register_provider(
            acct("cve.test"),
            "cve".to_string(),
            "https://example.test/v1/cve".to_string(),
            String::new(),
            milli(2),
            String::new(),
        );
        at("agent.test", 100 * DAY_NS);
        pay(&mut guard, "run-1", "cve.test", milli(3));
    }

    #[test]
    #[should_panic(expected = "ERR_OVER_PAYMENT_CAP")]
    fn the_per_payment_cap_holds() {
        let mut guard = guard();
        at("owner.test", 100 * DAY_NS);
        guard.register_provider(
            acct("big.test"),
            "big".to_string(),
            "https://example.test/v1/big".to_string(),
            String::new(),
            milli(100),
            String::new(),
        );
        at("agent.test", 100 * DAY_NS);
        pay(&mut guard, "run-1", "big.test", milli(11));
    }

    #[test]
    #[should_panic(expected = "ERR_OVER_RUN_CAP")]
    fn the_per_run_cap_holds() {
        let mut guard = guard();
        at("agent.test", 100 * DAY_NS);
        pay(&mut guard, "run-1", "kev.test", milli(10));
        pay(&mut guard, "run-1", "kev.test", milli(10));
        pay(&mut guard, "run-1", "kev.test", milli(6));
    }

    #[test]
    #[should_panic(expected = "ERR_TOO_MANY_PAYMENTS")]
    fn the_payment_count_cap_holds() {
        let mut guard = guard();
        at("agent.test", 100 * DAY_NS);
        for _ in 0..4 {
            pay(&mut guard, "run-1", "kev.test", milli(1));
        }
    }

    #[test]
    #[should_panic(expected = "ERR_OVER_DAY_CAP")]
    fn the_per_day_cap_holds_across_runs() {
        let mut guard = guard();
        at("agent.test", 100 * DAY_NS);
        pay(&mut guard, "run-1", "kev.test", milli(10));
        pay(&mut guard, "run-1", "kev.test", milli(10));
        pay(&mut guard, "run-2", "kev.test", milli(10));
        pay(&mut guard, "run-2", "kev.test", milli(10));
        pay(&mut guard, "run-3", "kev.test", milli(1));
    }

    #[test]
    fn the_day_cap_starts_again_the_next_day() {
        let mut guard = guard();
        at("agent.test", 100 * DAY_NS);
        pay(&mut guard, "run-1", "kev.test", milli(10));
        pay(&mut guard, "run-1", "kev.test", milli(10));
        pay(&mut guard, "run-2", "kev.test", milli(10));
        pay(&mut guard, "run-2", "kev.test", milli(10));
        at("agent.test", 101 * DAY_NS);
        assert_eq!(guard.get_status().spent_today, NearToken::from_yoctonear(0));
        pay(&mut guard, "run-3", "kev.test", milli(10));
        assert_eq!(guard.get_status().spent_today, milli(10));
    }

    #[test]
    #[should_panic(expected = "ERR_PAUSED")]
    fn a_paused_guard_pays_nothing() {
        let mut guard = guard();
        at("owner.test", 100 * DAY_NS);
        guard.set_paused(true);
        at("agent.test", 100 * DAY_NS);
        pay(&mut guard, "run-1", "kev.test", milli(1));
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_OWNER")]
    fn the_agent_cannot_change_the_policy() {
        let mut guard = guard();
        at("agent.test", 100 * DAY_NS);
        guard.set_policy(Policy {
            max_per_payment: NearToken::from_near(100),
            max_per_run: NearToken::from_near(100),
            max_per_day: NearToken::from_near(100),
            max_payments_per_run: 100,
        });
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_OWNER")]
    fn the_agent_cannot_register_a_provider() {
        let mut guard = guard();
        at("agent.test", 100 * DAY_NS);
        guard.register_provider(
            acct("evil.test"),
            "evil".to_string(),
            "https://evil.test".to_string(),
            String::new(),
            milli(10),
            String::new(),
        );
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_OWNER")]
    fn the_agent_cannot_withdraw() {
        let mut guard = guard();
        at("agent.test", 100 * DAY_NS);
        let _ = guard.withdraw(milli(1));
    }

    #[test]
    fn attesting_records_whether_the_work_passed() {
        let mut guard = guard();
        at("agent.test", 100 * DAY_NS);
        let first = pay(&mut guard, "run-1", "kev.test", milli(1));
        let second = pay(&mut guard, "run-1", "kev.test", milli(1));
        guard.settle(first, true);
        guard.settle(second, true);
        guard.attest(first, true);
        guard.attest(second, false);
        assert_eq!(guard.get_receipt(first).unwrap().passed, Some(true));
        assert_eq!(guard.get_receipt(second).unwrap().passed, Some(false));
        let stats = guard.get_receiver_stats(acct("kev.test"));
        assert_eq!((stats.passed, stats.failed), (1, 1));
    }

    #[test]
    #[should_panic(expected = "ERR_ALREADY_ATTESTED")]
    fn a_receipt_is_attested_once() {
        let mut guard = guard();
        at("agent.test", 100 * DAY_NS);
        let id = pay(&mut guard, "run-1", "kev.test", milli(1));
        guard.attest(id, true);
        guard.attest(id, false);
    }

    #[test]
    fn receipts_are_paged() {
        let mut guard = guard();
        at("agent.test", 100 * DAY_NS);
        pay(&mut guard, "run-1", "kev.test", milli(1));
        pay(&mut guard, "run-1", "kev.test", milli(2));
        pay(&mut guard, "run-2", "kev.test", milli(3));
        let page = guard.get_receipts(1, 10);
        assert_eq!(page.len(), 2);
        assert_eq!(page[0].id, 1);
        assert_eq!(page[1].amount, milli(3));
        assert!(guard.get_receipts(3, 10).is_empty());
    }

    #[test]
    fn providers_are_listed_with_their_block_state() {
        let mut guard = guard();
        at("agent.test", 100 * DAY_NS);
        guard.report(acct("kev.test"), "bad".to_string(), "evidence".to_string());
        let list = guard.get_providers();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].account_id, acct("kev.test"));
        assert!(list[0].blocked);
        assert_eq!(list[0].provider.label, "kev");
    }

    #[test]
    #[should_panic(expected = "ERR_BAD_INPUT")]
    fn a_policy_must_be_ordered() {
        at("owner.test", 100 * DAY_NS);
        Guard::new(
            acct("owner.test"),
            acct("agent.test"),
            Policy {
                max_per_payment: milli(50),
                max_per_run: milli(25),
                max_per_day: milli(40),
                max_payments_per_run: 3,
            },
        );
    }
}
