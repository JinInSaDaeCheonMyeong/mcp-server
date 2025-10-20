#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// 타입 정의
interface NoticeResult {
  title: string;
  url: string;
  score: number;
  metadata: {
    organization: string;
    region: string;
    startupHistory: string;
  };
}

interface SearchResponse {
  results: NoticeResult[];
}

// 스키마 정의
const SearchNoticeArgsSchema = z.object({
  query: z
    .string()
    .min(1, "검색어는 비워둘 수 없습니다")
    .describe("검색할 공고 쿼리 (예: '서울에서 열리는 공고 5개')"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(5)
    .describe("반환할 최대 공고 수 (1-50)"),
});

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

// 서버 설정
const server = new Server(
  {
    name: "notice-search-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// 공고 검색 함수
async function searchNotices(
  query: string,
  limit: number = 5
): Promise<NoticeResult[]> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10초 타임아웃

    const response = await fetch("https://ai.start-hub.kr/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(
        `API 응답 오류: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as SearchResponse;

    if (!data.results || !Array.isArray(data.results)) {
      throw new Error("잘못된 응답 형식입니다");
    }

    return data.results.slice(0, limit);
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === "AbortError") {
        throw new Error("요청 타임아웃: 검색 서버에서 응답이 없습니다");
      }
      throw error;
    }
    throw new Error(`공고 검색 중 오류 발생: ${String(error)}`);
  }
}

// 결과를 포맷팅된 텍스트로 변환
function formatResults(results: NoticeResult[], query: string): string {
  if (results.length === 0) {
    return `"${query}"에 대한 검색 결과가 없습니다.`;
  }

  const header = `총 ${results.length}개의 공고를 찾았습니다.\n${"=".repeat(60)}\n`;

  const formatted = results
    .map((result, index) => {
      const scorePercent = (result.score * 100).toFixed(1);
      return `
[${index + 1}] ${result.title}
URL: ${result.url}
기관: ${result.metadata.organization}
지역: ${result.metadata.region}
대상: ${result.metadata.startupHistory}
유사도: ${scorePercent}%`;
    })
    .join("\n\n" + "-".repeat(60) + "\n");

  return header + formatted;
}

// 도구 목록 핸들러
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search_notices",
        description:
          "사용자의 요청과 관련된 스타트업 공고를 검색합니다. " +
          "키워드나 조건을 포함한 자연스러운 쿼리를 입력하면 " +
          "유사한 공고들을 찾아 반환합니다. " +
          "예: '서울에서 열리는 공고', '기술 스타트업 지원', '멘토링 프로그램'",
        inputSchema: zodToJsonSchema(SearchNoticeArgsSchema) as ToolInput,
      },
    ],
  };
});

// 도구 호출 핸들러
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    if (name === "search_notices") {
      const parsed = SearchNoticeArgsSchema.safeParse(args);
      if (!parsed.success) {
        const errorMessages = parsed.error.errors
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join(", ");
        throw new Error(`잘못된 인자: ${errorMessages}`);
      }

      const results = await searchNotices(
        parsed.data.query,
        parsed.data.limit
      );
      const formatted = formatResults(results, parsed.data.query);

      return {
        content: [
          {
            type: "text",
            text: formatted,
          },
        ],
      };
    }

    throw new Error(`알 수 없는 도구: ${name}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `오류: ${errorMessage}` }],
      isError: true,
    };
  }
});

// 서버 시작
async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("공고 검색 MCP 서버가 시작되었습니다 (stdio)");
}

runServer().catch((error) => {
  console.error("서버 실행 중 치명적 오류:", error);
  process.exit(1);
});