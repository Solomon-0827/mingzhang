import React from "react";
import { ConfigProvider, DatePicker, Select } from "antd";
import { categoryGroups, categoryLeaf } from "./category-groups";
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
          colorPrimary: "#4a5d4e",
          colorText: "#2a2724",
          colorBorder: "#d9d2c3",
          colorBgElevated: "#fffdf7",
          colorBgContainer: "#fffdf7",
          borderRadius: 10,
          controlHeight: 44,
          fontSize: 14,
          fontFamily: '"Playfair Display", "Noto Serif SC", "Songti SC", "STSong", serif',
          colorPrimaryBg: "#f3ecdd",
          boxShadowSecondary: "0 12px 36px rgba(51,45,30,.12)",
        },
        components: {
          Select: { optionSelectedBg: "#f3ecdd", optionHeight: 38 },
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
  onOpenChange?: (open: boolean) => void;
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
      panelRender={(panel) => (
        <div onClick={(event) => event.stopPropagation()}>{panel}</div>
      )}
      disabledDate={(date) => Boolean(max && date.format("YYYY-MM-DD") > max)}
      onChange={(date) => {
        if (date)
          onChange({
            target: {
              value: date.format(type === "month" ? "YYYY-MM" : "YYYY-MM-DD"),
            },
          });
      }}
      // Keep calendar clicks outside the surrounding label: otherwise native
      // label activation can focus the input and reopen the calendar.
      getPopupContainer={() => document.body}
      styles={{ popup: { root: { zIndex: 1400 } } }}
    />
  );
}

export function CategorySelect({ options, value, onChange, disabled, "aria-label": label = "分类" }: {
  options: string[]; value: string; onChange: Change; disabled?: boolean; "aria-label"?: string;
}) {
  return <Select className="ledger-select category-select" aria-label={label} value={value} disabled={disabled}
    virtual={false} listHeight={420} showSearch optionFilterProp="searchText" popupMatchSelectWidth={280}
    options={categorySelectOptions(options)}
    onChange={next => onChange({target:{value:next}})}
    getPopupContainer={trigger => trigger.parentElement!} />;
}

function categorySelectOptions(options: string[]) {
  return categoryGroups(options).map(group => ({ label: <strong className="category-heading">{group.name}</strong>,
      options: group.items.map(item => ({ value: item, searchText: item,
        label: <span className="category-option"><span className="category-parent">{group.name}</span><span>{categoryLeaf(item)}</span></span> })) }));
}

export function CategoryMultiSelect({ options, value, onChange }: {
  options: string[]; value: string[]; onChange: (value: string[]) => void;
}) {
  return <Select className="ledger-select category-select book-category-select"
    aria-label="清单分类" mode="multiple" size="small" placeholder="全部分类"
    value={value} onChange={onChange} options={categorySelectOptions(options)}
    allowClear maxTagCount="responsive" virtual={false} listHeight={420}
    showSearch optionFilterProp="searchText" popupMatchSelectWidth={300}
    getPopupContainer={trigger => trigger.parentElement!} />;
}
