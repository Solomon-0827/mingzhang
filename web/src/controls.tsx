import React from "react";
import { ConfigProvider, DatePicker, Select } from "antd";
import zhCN from "antd/locale/zh_CN";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";

dayjs.locale("zh-cn");

export function ControlTheme({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: "#257864",
          colorText: "#2d443a",
          colorBorder: "#dfe5dd",
          colorBgElevated: "#ffffff",
          borderRadius: 10,
          controlHeight: 44,
          fontSize: 14,
          fontFamily: "inherit",
          colorPrimaryBg: "#eaf3ec",
          boxShadowSecondary: "0 12px 36px rgba(30,65,48,.14)",
        },
        components: {
          Select: { optionSelectedBg: "#eaf3ec", optionHeight: 38 },
          DatePicker: { cellHeight: 34 },
        },
      }}
    >
      {children}
    </ConfigProvider>
  );
}

type Change = (event: { target: { value: string } }) => void;
export function StyledSelect({
  children,
  value,
  onChange,
  required,
  ...props
}: {
  children: React.ReactNode;
  value?: string;
  onChange: Change;
  required?: boolean;
  disabled?: boolean;
  size?: "small" | "middle" | "large";
  "aria-label"?: string;
}) {
  const options = React.Children.toArray(children)
    .filter(React.isValidElement)
    .map((child) => {
      const option = child as React.ReactElement<{
        value: string;
        children: React.ReactNode;
      }>;
      return { value: option.props.value, label: option.props.children };
    });
  return (
    <Select
      {...props}
      className="ledger-select"
      value={value}
      options={options}
      aria-required={required}
      virtual={false}
      onChange={(next) => onChange({ target: { value: next } })}
      getPopupContainer={(trigger) => trigger.parentElement!}
    />
  );
}

export function StyledDate({
  value,
  onChange,
  type,
  max,
  ...props
}: {
  value: string;
  onChange: Change;
  type: "date" | "month";
  max?: string;
  disabled?: boolean;
  open?: boolean;
  required?: boolean;
  size?: "small" | "middle" | "large";
  "aria-label"?: string;
}) {
  return (
    <DatePicker
      {...props}
      className="ledger-date"
      value={dayjs(value)}
      picker={type === "month" ? "month" : "date"}
      format={type === "month" ? "YYYY年MM月" : "YYYY年MM月DD日"}
      allowClear={false}
      inputReadOnly
      disabledDate={(date) => Boolean(max && date.format("YYYY-MM-DD") > max)}
      onChange={(date) => {
        if (date)
          onChange({
            target: {
              value: date.format(type === "month" ? "YYYY-MM" : "YYYY-MM-DD"),
            },
          });
      }}
      getPopupContainer={(trigger) => trigger.parentElement!}
    />
  );
}
