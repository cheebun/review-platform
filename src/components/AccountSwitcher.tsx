"use client";

import {
  ACCOUNT_STORAGE_KEY,
  DEFAULT_GITHUB_ACCOUNT,
  GITHUB_ACCOUNTS,
  parseGithubAccount,
  type GithubAccount,
} from "@/lib/accounts";
import { UserOutlined } from "@ant-design/icons";
import { Select } from "antd";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

type AccountContextValue = {
  account: GithubAccount;
  setAccount: (account: GithubAccount) => void;
};

const AccountContext = createContext<AccountContextValue | null>(null);

export function AccountProvider({ children }: { children: ReactNode }) {
  const [account, setAccountState] = useState<GithubAccount>(DEFAULT_GITHUB_ACCOUNT);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setAccountState(parseGithubAccount(localStorage.getItem(ACCOUNT_STORAGE_KEY)));
    setReady(true);
  }, []);

  function setAccount(next: GithubAccount) {
    setAccountState(next);
    localStorage.setItem(ACCOUNT_STORAGE_KEY, next);
  }

  return (
    <AccountContext.Provider
      value={{ account: ready ? account : DEFAULT_GITHUB_ACCOUNT, setAccount }}
    >
      {children}
    </AccountContext.Provider>
  );
}

export function useGithubAccount() {
  const ctx = useContext(AccountContext);
  if (!ctx) throw new Error("useGithubAccount must be used within AccountProvider");
  return ctx;
}

export function AccountSwitcher() {
  const { account, setAccount } = useGithubAccount();

  return (
    <Select
      className="account-select"
      size="middle"
      value={account}
      aria-label="GitHub account"
      style={{ width: 168 }}
      suffixIcon={<UserOutlined style={{ color: "#4b5563" }} />}
      options={GITHUB_ACCOUNTS.map((item) => ({ label: item, value: item }))}
      onChange={(value) => setAccount(parseGithubAccount(value))}
    />
  );
}
