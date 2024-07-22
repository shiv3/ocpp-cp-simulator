import React, { useEffect, useRef} from "react";

interface LoggerProps {
  logs: string[];
}

const Logger: React.FC<LoggerProps> = ({logs}) => {
  return (
    <div className="mt-2 border-0 border-blue-500 h-screen">
      <AutoScrollingTextarea
        readOnly
        className="w-full h-1/4 bg-gray-100 p-2"
        value={logs.join("\n")}
      />
    </div>
  );
};

export default Logger;

type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

const AutoScrollingTextarea: React.FC<TextareaProps> = (props) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    textareaRef.current?.scrollTo({
      top: textareaRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [props.value]);

  return <textarea className="w-full h-auto" ref={textareaRef} {...props} />;
};
