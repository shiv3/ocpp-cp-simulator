import React, {useState, useEffect, useRef} from "react";

const Logger: React.FC = () => {
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    // You might want to implement a more sophisticated logging system
    // This is just a basic example
    const oldConsoleLog = console.log;
    console.log = (message: string) => {
      setLogs((prevLogs) => [...prevLogs, message]);
    };

    return () => {
      console.log = oldConsoleLog;
    };
  }, []);

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

type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>

const AutoScrollingTextarea: React.FC<TextareaProps> = (props) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    textareaRef.current?.scrollTo({
      top: textareaRef.current.scrollHeight,
      behavior: "smooth"
    });
  }, [props.value]);

  return <textarea
    className="w-full h-auto"
    ref={textareaRef} {...props}/>;
}
